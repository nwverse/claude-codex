import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const adapter = resolve('dist/src/adapter.mjs')

interface DaemonSetup {
  home: string
  sock: string
  pidFile: string
}

// A short socket path: unix socket paths are limited to about 100 bytes.
async function setup(): Promise<DaemonSetup> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-pid-${randomUUID().slice(0, 8)}.sock`)
  return { home, sock, pidFile: `${sock}.pid` }
}

async function cleanup({ home, sock, pidFile }: DaemonSetup): Promise<void> {
  await rm(sock, { force: true })
  await rm(pidFile, { force: true })
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
}

// State, debug log and orphan registry stay in the test home, whatever the
// shell running the suite points at.
function daemonEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  delete env.CLAUDE_CODEX_HOME
  delete env.CLAUDE_CODEX_DEBUG_LOG
  return env
}

function startDaemon({ home, sock }: DaemonSetup, env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...daemonEnv(home), ...env },
  })
}

// A PATH whose `ps` runs `script` (sh) first, then the real ps with the
// arguments it was given, unless the script exits.
async function psStubPath({ home }: DaemonSetup, script: string): Promise<string> {
  const dir = join(home, 'bin')
  await mkdir(dir, { recursive: true })
  const path = process.env.PATH ?? ''
  const quoted = `'${path.replaceAll("'", "'\\''")}'`
  await writeFile(
    join(dir, 'ps'),
    `#!/bin/sh\n${script}\nPATH=${quoted}\nexport PATH\nexec ps "$@"\n`,
    { mode: 0o755 },
  )
  return `${dir}${delimiter}${path}`
}

// A live process named by a pid file dated `ageMs` ago.
async function pidFileFor(state: DaemonSetup, ageMs: number): Promise<ChildProcess> {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  await once(other, 'spawn')
  await writeFile(state.pidFile, `${other.pid}\n`)
  const date = new Date(Date.now() - ageMs)
  await utimes(state.pidFile, date, date)
  return other
}

// Resolves with the stderr seen once it matches; rejects if the process exits
// first or nothing matches in time.
function waitForStderr(proc: ChildProcess, pattern: RegExp, timeoutMs = 8000): Promise<string> {
  const stderr = proc.stderr
  if (!stderr) throw new Error('test process has no stderr')
  stderr.setEncoding('utf8')
  let seen = ''
  return new Promise((resolvePromise, reject) => {
    const finish = (error: Error | null) => {
      clearTimeout(timer)
      stderr.off('data', onData)
      proc.off('exit', onExit)
      if (error) reject(error)
      else resolvePromise(seen)
    }
    const onData = (chunk: string) => {
      seen += chunk
      if (pattern.test(seen)) finish(null)
    }
    const onExit = () => finish(new Error(`exited before stderr matched ${pattern}; saw: ${seen}`))
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for stderr ${pattern}; saw: ${seen}`)),
      timeoutMs,
    )
    stderr.on('data', onData)
    proc.once('exit', onExit)
  })
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill()
  const done = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
  if (!done) {
    proc.kill('SIGKILL')
    await exited
  }
}

// The daemon starts despite the pid file and leaves its own pid there, as
// plain text a script can hand to kill.
async function assertDaemonReplacesPidFile(
  state: DaemonSetup,
  daemon = startDaemon(state),
): Promise<void> {
  try {
    // Well inside the 10 s startup grace window, so a pid file wrongly taken
    // for a starting daemon makes this time out.
    const stderr = await waitForStderr(daemon, /listening on/, 8000)
    assert.doesNotMatch(stderr, /already running/)
    assert.equal(await readFile(state.pidFile, 'utf8'), `${daemon.pid}\n`)
  } finally {
    await stopProcess(daemon)
  }
}

for (const [name, content] of [
  ['an empty', ''],
  ['a newline-only', '\n'],
  ['a zero', '0\n'],
  ['a negative', '-1\n'],
  ['an init (pid 1)', '1\n'],
] as const) {
  test(`${name} daemon pid file does not block startup`, { timeout: 15_000 }, async () => {
    const state = await setup()
    try {
      await writeFile(state.pidFile, content)
      await assertDaemonReplacesPidFile(state)
    } finally {
      await cleanup(state)
    }
  })
}

test('a recycled pid with no socket behind it does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  // A live process of the same user that is not a daemon, as after a reboot.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}\n`)
    // Older than the window in which a starting daemon may not listen yet.
    const old = new Date(Date.now() - 60_000)
    await utimes(state.pidFile, old, old)
    await assertDaemonReplacesPidFile(state)
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

test('a running daemon still turns away a second one', { timeout: 15_000 }, async () => {
  const state = await setup()
  const first = startDaemon(state)
  try {
    await waitForStderr(first, /listening on/)
    const second = startDaemon(state)
    try {
      const stderr = await waitForStderr(second, /already running/)
      assert.match(stderr, new RegExp(`\\(pid ${first.pid}\\)`))
      const code = second.exitCode ?? (await once(second, 'exit'))[0]
      assert.equal(code, 0)
    } finally {
      await stopProcess(second)
    }
    assert.equal(await readFile(state.pidFile, 'utf8'), `${first.pid}\n`)
  } finally {
    await stopProcess(first)
    await cleanup(state)
  }
})

test('a live pid followed by other text does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  // parseInt would read the live pid and, as the file is fresh, wait out the
  // startup grace window for a daemon that never listens.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}abc\n`)
    await assertDaemonReplacesPidFile(state)
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

test('a pid file naming the starting daemon itself does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  try {
    // The shell writes its own pid, then exec keeps that pid for the daemon,
    // so the fresh pid file names a live process that is not listening yet.
    const daemon = spawn(
      'sh',
      [
        '-c',
        'echo $$ > "$1"; shift; exec "$@"',
        'sh',
        state.pidFile,
        process.execPath,
        adapter,
        'app-server',
        '--listen',
        `unix://${state.sock}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: daemonEnv(state.home) },
    )
    await assertDaemonReplacesPidFile(state, daemon)
  } finally {
    await cleanup(state)
  }
})

interface StartingDaemon {
  // A live process named by a fresh pid file that does not listen yet, as
  // when a first daemon has written its pid but not opened its socket.
  other: ChildProcess
  // A daemon started behind it, which should be waiting.
  second: ChildProcess
}

// Runs check with both processes and stops them afterwards, even when check
// or the waiting assertions fail.
async function withStartingDaemon(
  state: DaemonSetup,
  check: (procs: StartingDaemon) => Promise<void>,
): Promise<void> {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  let second: ChildProcess | undefined
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}\n`)
    second = startDaemon(state)
    // Several 200 ms polls later, the second daemon is still waiting: it has
    // neither exited nor replaced the pid file.
    await delay(800)
    assert.equal(second.exitCode, null)
    assert.equal(await readFile(state.pidFile, 'utf8'), `${other.pid}\n`)
    await check({ other, second })
  } finally {
    if (second) await stopProcess(second)
    await stopProcess(other)
  }
}

test('a daemon still starting turns away a second one once it listens', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  const server = createServer((socket) => socket.destroy())
  try {
    await withStartingDaemon(state, async ({ other, second }) => {
      const stderr = waitForStderr(second, /already running/)
      server.listen(state.sock)
      await once(server, 'listening')
      assert.match(await stderr, new RegExp(`\\(pid ${other.pid}\\)`))
      const code = second.exitCode ?? (await once(second, 'exit'))[0]
      assert.equal(code, 0)
      assert.equal(await readFile(state.pidFile, 'utf8'), `${other.pid}\n`)
    })
  } finally {
    server.close()
    await cleanup(state)
  }
})

test('a daemon that dies while starting lets the waiting one take over', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  try {
    await withStartingDaemon(state, async ({ other, second }) => {
      await stopProcess(other)
      await assertDaemonReplacesPidFile(state, second)
    })
  } finally {
    await cleanup(state)
  }
})

test('a daemon slow to start is left to finish, not joined by a second one', {
  timeout: 30_000,
}, async () => {
  const state = await setup()
  try {
    await withStartingDaemon(state, async ({ other, second }) => {
      // The process started before its fresh pid file was written, so it is
      // the daemon, still starting. The second one gives up waiting after
      // 10 s and leaves it to finish.
      const stderr = await waitForStderr(second, /already starting|listening on/, 20_000)
      assert.match(stderr, new RegExp(`already starting at .*\\(pid ${other.pid}\\)`))
      const code = second.exitCode ?? (await once(second, 'exit'))[0]
      assert.equal(code, 0)
      assert.equal(await readFile(state.pidFile, 'utf8'), `${other.pid}\n`)
    })
  } finally {
    await cleanup(state)
  }
})

test('a live pid whose start ps cannot read holds a pid file only 10 s', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  const other = await pidFileFor(state, 60_000)
  try {
    // No ps on PATH, as on a slim image: whether the process is the daemon
    // that wrote the pid file is unknown, so only the startup grace applies.
    const empty = join(state.home, 'empty')
    await mkdir(empty)
    await assertDaemonReplacesPidFile(state, startDaemon(state, { PATH: empty }))
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

test('a daemon that has not listened a minute after its pid file was written is replaced', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  const other = await pidFileFor(state, 61_000)
  try {
    // ps says the process started before the pid file was written, so it is
    // the daemon, but one that hung while starting or a zombie no one reaps.
    const path = await psStubPath(
      state,
      `for last; do :; done\nif [ "$last" = "${other.pid}" ]; then echo "${other.pid} 1 Wed Jan  1 10:00:00 2020 sleep 30"; exit 0; fi`,
    )
    await assertDaemonReplacesPidFile(state, startDaemon(state, { PATH: path }))
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

// Another server listening at the path, and the inode of its socket.
async function socketServer(sock: string): Promise<{ server: Server; inode: number }> {
  const server = createServer((socket) => socket.destroy())
  server.listen(sock)
  await once(server, 'listening')
  return { server, inode: (await lstat(sock)).ino }
}

// Whether a server still accepts a connection at the path.
async function accepts(sock: string): Promise<boolean> {
  const socket = connect(sock)
  try {
    await once(socket, 'connect')
    return true
  } catch {
    return false
  } finally {
    socket.destroy()
  }
}

test('a socket that still accepts connections is never removed for a stale pid file', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  const gone = spawn('true', { stdio: 'ignore' })
  await once(gone, 'exit')
  await writeFile(state.pidFile, `${gone.pid}\n`)
  const { server, inode } = await socketServer(state.sock)
  try {
    const daemon = startDaemon(state)
    try {
      const stderr = await waitForStderr(daemon, /already running|listening on/)
      assert.match(stderr, /app-server already running at /)
      const code = daemon.exitCode ?? (await once(daemon, 'exit'))[0]
      assert.equal(code, 0)
    } finally {
      await stopProcess(daemon)
    }
    assert.equal((await lstat(state.sock)).ino, inode)
    assert.equal(await accepts(state.sock), true)
    assert.equal(await readFile(state.pidFile, 'utf8'), `${gone.pid}\n`)
  } finally {
    server.close()
    await cleanup(state)
  }
})

test('a daemon that finds its socket taken by another one when it binds leaves it', {
  timeout: 20_000,
}, async () => {
  const state = await setup()
  // Startup recovery reads the daemon's own start time with ps after the pid
  // file is written and before the socket is bound. This ps waits for the
  // gate, so another daemon that saw no pid file either can bind meanwhile.
  const gate = join(state.home, 'gate')
  const path = await psStubPath(
    state,
    `i=0\nwhile [ ! -e '${gate}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done`,
  )
  const daemon = startDaemon(state, { PATH: path })
  let server: Server | undefined
  try {
    const deadline = Date.now() + 8000
    while (!existsSync(state.pidFile) && daemon.exitCode === null && Date.now() < deadline)
      await delay(20)
    assert.equal(existsSync(state.pidFile), true, 'the daemon writes its pid file')
    const taken = await socketServer(state.sock)
    server = taken.server
    const stderr = waitForStderr(daemon, /already running|listening on/)
    await writeFile(gate, '')
    assert.match(await stderr, /app-server already running at /)
    const code = daemon.exitCode ?? (await once(daemon, 'exit'))[0]
    assert.equal(code, 0)
    assert.equal((await lstat(state.sock)).ino, taken.inode)
    assert.equal(await accepts(state.sock), true)
    // The pid file it wrote goes with it.
    assert.equal(existsSync(state.pidFile), false)
  } finally {
    await writeFile(gate, '').catch(() => {})
    await stopProcess(daemon)
    server?.close()
    await cleanup(state)
  }
})
