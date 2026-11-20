import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Keep debug.jsonl out of the developer's ~/.codex.
process.env.CLAUDE_CODEX_DEBUG_LOG = '0'

// How process/kill and timeoutMs stop a process/spawn process: its whole
// process group, as command/exec, with SIGKILL for what ignores SIGTERM.

test('process/kill stops what a process without a pty started, not only the process', {
  timeout: 20_000,
}, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const pids: number[] = []
    try {
      await app.request('process/spawn', {
        processHandle: 'p',
        command: ['sh', '-c', 'sleep 300 & echo $$ $!; wait'],
        cwd: app.home,
        streamStdoutStderr: true,
        streamStdin: true,
      })
      pids.push(...(await app.waitFor(() => printedPids(app, 'p'))))

      await app.request('process/kill', { processHandle: 'p' })

      for (const pid of pids) assert.ok(await exits(pid, 5_000), `process ${pid} still runs`)
      await app.waitFor(() => exitOf(app, 'p'))
    } finally {
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

test('a process without a pty that reaches timeoutMs is stopped with its group and reports its exit', {
  timeout: 20_000,
}, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const pids: number[] = []
    const spawnWithTimeout = async (processHandle: string, script: string) => {
      await app.request('process/spawn', {
        processHandle,
        command: ['sh', '-c', script],
        cwd: app.home,
        streamStdoutStderr: true,
        timeoutMs: 2_000,
      })
      pids.push(...(await app.waitFor(() => printedPids(app, processHandle))))
    }
    try {
      // Exits on SIGTERM, but leaves a child that ignores it.
      await spawnWithTimeout('leaves', '(trap "" TERM; exec sleep 300) & echo $$ $!; wait')
      // Ignores SIGTERM itself.
      await spawnWithTimeout('ignores', 'trap "" TERM; echo $$; while :; do sleep 0.1; done')

      for (const pid of pids) assert.ok(await exits(pid, 5_000), `process ${pid} still runs`)
      await app.waitFor(() => exitOf(app, 'leaves'))
      await app.waitFor(() => exitOf(app, 'ignores'))
    } finally {
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

// The pty bridge stops its shell's session itself (SIGTERM, then SIGKILL)
// when told to; a SIGTERM to the bridge left a shell ignoring SIGHUP running.
test('a terminal that reaches timeoutMs has its shell stopped', { timeout: 20_000 }, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    let pid = 0
    try {
      await app.request('process/spawn', {
        processHandle: 'tty',
        command: ['sh', '-c', 'trap "" HUP; echo $$; while :; do sleep 0.1; done'],
        cwd: app.home,
        tty: true,
        // Past the bridge's start, which takes a second on a busy machine.
        timeoutMs: 3_000,
      })
      pid = (await app.waitFor(() => printedPids(app, 'tty')))[0] ?? 0

      assert.ok(await exits(pid, 5_000), `shell ${pid} still runs`)
      await app.waitFor(() => exitOf(app, 'tty'))
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

// The pids a process printed first, as `echo $$ [$!]` prints them.
function printedPids(app: InProcessApp, processHandle: string): number[] | undefined {
  const printed = app
    .notified('process/outputDelta')
    .filter((delta) => delta.processHandle === processHandle)
    .map((delta) => Buffer.from(delta.deltaBase64, 'base64').toString('utf8'))
    .join('')
  const found = /^(\d+)(?: (\d+))?\r?\n/.exec(printed)
  return found ? found.slice(1).filter(Boolean).map(Number) : undefined
}

function exitOf(app: InProcessApp, processHandle: string): unknown {
  return app.notified('process/exited').find((exit) => exit.processHandle === processHandle)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exits(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > end) return false
    await delay(50)
  }
  return true
}
