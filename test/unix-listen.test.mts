import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  parseProxySockArg,
  removeStaleSocket,
  startWebSocketTransport,
} from '../src/transports.mjs'

const adapter = resolve('dist/src/adapter.mjs')

// Short, so the socket path stays within the sockaddr_un limit on macOS too.
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ccx-'))
}

function startDaemon(home: string, sock: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  })
}

function collectStderr(proc: ChildProcess): () => string {
  let text = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([once(proc, 'exit').then(([code]) => code as number | null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

// Why a unix listener at the path fails to start, or null when it starts. One
// that starts is closed again, so it cannot keep the test process alive.
async function listenError(path: string): Promise<string | null> {
  try {
    const transport = await startWebSocketTransport(
      `unix://${path}`,
      () => {},
      () => {},
    )
    await transport.close()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// A socket file with no server behind it, as a SIGKILLed daemon leaves.
async function leaveStaleSocket(sock: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))',
      sock,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await once(child.stdout, 'data')
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.equal(existsSync(sock), true, 'the killed listener leaves its socket')
}

test('a unix listener refuses a path that holds a regular file or a directory', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'notes.txt')
    await writeFile(file, 'keep\n')
    assert.equal(await listenError(file), `refusing to replace non-socket file at ${file}`)
    assert.equal(await readFile(file, 'utf8'), 'keep\n')

    const link = join(dir, 'link')
    await symlink(file, link)
    assert.equal(await listenError(link), `refusing to replace non-socket file at ${link}`)
    assert.equal(await readlink(link), file)

    const folder = join(dir, 'folder')
    await mkdir(folder)
    await writeFile(join(folder, 'inside.txt'), 'keep\n')
    assert.equal(await listenError(folder), `refusing to replace non-socket file at ${folder}`)
    assert.equal(await readFile(join(folder, 'inside.txt'), 'utf8'), 'keep\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a socket at the exact platform byte limit accepts a connection on its full path', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp('/tmp/ccx-limit-')
  const limit = process.platform === 'darwin' ? 104 : 108
  const remaining = limit - Buffer.byteLength(root + '/')
  const path = join(root, '界'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3))
  try {
    assert.equal(Buffer.byteLength(path), limit)
    const transport = await startWebSocketTransport(
      `unix://${path}`,
      () => {},
      () => {},
    )
    try {
      assert.ok(existsSync(path))
      const socket = net.createConnection(parseProxySockArg(['--sock', path]))
      try {
        await once(socket, 'connect')
      } finally {
        socket.destroy()
      }
      assert.throws(() => parseProxySockArg(['--sock', path + 'x']), /Unix socket path exceeds/)
    } finally {
      await transport.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Unix daemons preserve existing parent modes and create private sockets and new directories', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp('/tmp/ccx-modes-')
  try {
    for (const [name, existingMode] of [
      ['explicit', 0o755],
      ['new', 0],
      ['fallback', 0o1777],
    ] as const) {
      const parent = join(root, name)
      if (existingMode) {
        await mkdir(parent)
        await chmod(parent, existingMode)
      }
      const fallback = name === 'fallback'
      const home = join(root, fallback ? 'x'.repeat(110) : name + '-home')
      const sock = fallback ? '' : join(parent, 'sock')
      const daemon = startDaemon(home, sock, { TMPDIR: fallback ? parent : root })
      const stderr = collectStderr(daemon)
      try {
        assert.ok(await waitFor(() => /listening on/.test(stderr()), 5000), stderr())
        const bound = /listening on ([^\n]+)/.exec(stderr())?.[1]
        assert.ok(bound)
        assert.equal(dirname(bound), parent)
        assert.equal((await stat(parent)).mode & 0o7777, existingMode || 0o700)
        assert.equal((await stat(bound)).mode & 0o077, 0)
        assert.equal((await stat(bound + '.pid')).mode & 0o077, 0)
        const probe = net.createConnection(bound)
        try {
          await once(probe, 'connect')
        } finally {
          probe.destroy()
        }
      } finally {
        daemon.kill('SIGTERM')
        await waitForExit(daemon, 4000)
      }
    }
    const unlocked = join(root, 'shared')
    await mkdir(unlocked)
    await chmod(unlocked, 0o777)
    const socket = join(unlocked, 's')
    const daemon = startDaemon(join(root, 'unused-home'), socket)
    const stderr = collectStderr(daemon)
    try {
      assert.equal(await waitForExit(daemon, 4000), 1)
      assert.match(stderr(), /directory .* is writable by others/)
      assert.equal((await stat(unlocked)).mode & 0o7777, 0o777)
      assert.equal(existsSync(socket + '.pid'), false)
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('binding a private Unix socket restores the caller umask', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp('/tmp/ccx-mask-')
  const previous = process.umask(0o002)
  try {
    const path = join(dir, 'socket')
    const transport = await startWebSocketTransport(
      `unix://${path}`,
      () => {},
      () => {},
    )
    try {
      assert.equal(process.umask(), 0o002)
      assert.equal((await stat(path)).mode & 0o077, 0)
    } finally {
      await transport.close()
    }
  } finally {
    process.umask(previous)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a unix listener replaces a stale socket', async () => {
  const dir = await tempDir()
  try {
    const sock = join(dir, 's.sock')
    await leaveStaleSocket(sock)
    const transport = await startWebSocketTransport(
      `unix://${sock}`,
      () => {},
      () => {},
    )
    try {
      const probe = net.createConnection(sock)
      await once(probe, 'connect')
      probe.destroy()
    } finally {
      await transport.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a unix listener leaves a socket that another server still listens on', async () => {
  const dir = await tempDir()
  const sock = join(dir, 's.sock')
  const server = net.createServer((socket) => socket.destroy())
  try {
    server.listen(sock)
    await once(server, 'listening')
    const inode = (await stat(sock)).ino
    assert.match((await listenError(sock)) ?? '', /EADDRINUSE/)
    assert.equal((await stat(sock)).ino, inode)
    const probe = net.createConnection(sock)
    try {
      await once(probe, 'connect')
    } finally {
      probe.destroy()
    }
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a socket whose server does not answer in time is not taken for stale', async () => {
  const dir = await tempDir()
  const sock = join(dir, 's.sock')
  const server = net.createServer((socket) => socket.destroy())
  try {
    server.listen(sock)
    await once(server, 'listening')
    const inode = (await stat(sock)).ino
    // The probe's one-second timer fires before the connection is seen, as
    // when the event loop stalls on synchronous work: the answer is unsure.
    const kept = await new Promise<boolean>((resolve) =>
      setImmediate(() => {
        const result = removeStaleSocket(sock)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
        resolve(result)
      }),
    )
    assert.equal(kept, false)
    assert.equal((await stat(sock)).ino, inode)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unix daemon exits 1 and leaves a regular file at its socket path alone', {
  timeout: 30_000,
}, async () => {
  const dir = await tempDir()
  const file = join(dir, 'notes.txt')
  await writeFile(file, 'keep\n')
  const proc = startDaemon(join(dir, 'home'), file)
  const stderr = collectStderr(proc)
  try {
    assert.equal(await waitForExit(proc, 10_000), 1, stderr())
    assert.equal(
      stderr(),
      `[claude-codex-adapter] refusing to replace non-socket file at ${file}\n`,
    )
    assert.equal(await readFile(file, 'utf8'), 'keep\n')
    assert.equal(existsSync(`${file}.pid`), false)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('unix daemon replaces a stale socket left by a killed daemon', {
  timeout: 30_000,
}, async () => {
  const dir = await tempDir()
  const sock = join(dir, 's.sock')
  await leaveStaleSocket(sock)
  const proc = startDaemon(join(dir, 'home'), sock)
  const stderr = collectStderr(proc)
  try {
    assert.ok(await waitFor(() => /listening on/.test(stderr()), 10_000), stderr())
    const probe = net.createConnection(sock)
    await once(probe, 'connect')
    probe.destroy()
    proc.kill('SIGTERM')
    assert.equal(await waitForExit(proc, 10_000), 0)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
