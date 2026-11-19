import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { withInProcessApp } from './fixtures/in-process-app.mjs'

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
