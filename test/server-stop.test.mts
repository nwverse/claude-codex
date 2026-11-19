import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { withInProcessApp } from './fixtures/in-process-app.mjs'

// Keep debug.jsonl out of the developer's ~/.codex.
process.env.CLAUDE_CODEX_DEBUG_LOG = '0'

// What a stopped server leaves behind: a terminal its client still has open
// has no timeout, and a daemon's child would outlive it.

test('stopping the server ends the terminals still open', { timeout: 20_000 }, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    let pid = 0
    try {
      await app.request('process/spawn', {
        processHandle: 'terminal',
        command: ['sh', '-c', 'echo $$; exec sleep 300'],
        cwd: app.home,
        streamStdoutStderr: true,
        streamStdin: true,
      })
      pid = await app.waitFor(() => {
        const printed = app
          .notified('process/outputDelta')
          .map((delta) => Buffer.from(delta.deltaBase64, 'base64').toString('utf8'))
          .join('')
        const found = /^(\d+)\n/.exec(printed)
        return found ? Number(found[1]) : undefined
      })

      await app.server.stop()

      assert.ok(await exits(pid, 5_000), `process ${pid} outlived the server`)
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

// A terminal's process can exit while a child it left in the background holds
// its pipes, and so its handle, open. Its pid is free by then: a signal to it,
// or to the group of that id, could reach another process.
test('a terminal whose process has exited is not signalled again', {
  timeout: 20_000,
}, async (t) => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    let background = 0
    try {
      await app.request('process/spawn', {
        processHandle: 'terminal',
        command: ['sh', '-c', 'sleep 30 & echo $$ $!'],
        cwd: app.home,
        streamStdoutStderr: true,
      })
      const [shell, sleep] = await app.waitFor(() => {
        const printed = app
          .notified('process/outputDelta')
          .map((delta) => Buffer.from(delta.deltaBase64, 'base64').toString('utf8'))
          .join('')
        const found = /^(\d+) (\d+)\n/.exec(printed)
        return found ? [Number(found[1]), Number(found[2])] : undefined
      })
      background = sleep
      // Gone once the server has reaped it.
      assert.ok(await exits(shell, 5_000), `shell ${shell} still runs`)
      const again = await app.call('process/spawn', {
        processHandle: 'terminal',
        command: ['true'],
        cwd: app.home,
      })
      assert.match(again.error?.message ?? '', /already active/, 'the handle is still taken')

      const signalled: unknown[] = []
      const kill = process.kill
      t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
        if (Math.abs(pid) !== shell) return kill.call(process, pid, signal)
        signalled.push([pid, signal])
        return true
      })
      await app.request('process/kill', { processHandle: 'terminal' })
      await app.server.stop()
      app.server.closePeer({ id: 'app', send: () => {}, close: () => {} })
      // Past the SIGKILL that follows a SIGTERM.
      await delay(1_200)
      assert.deepEqual(signalled, [])
    } finally {
      if (background && isAlive(background)) process.kill(background, 'SIGKILL')
    }
  })
})

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
