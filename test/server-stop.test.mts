import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

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

// A daemon exits as soon as stop() returns, dropping any timer: the SIGKILL
// for what ignores SIGTERM has to go out before. Its clients disconnect after
// that, and must not signal the same processes again.
test('stopping the server signals each process group once, SIGKILL included, before it returns', {
  timeout: 20_000,
}, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const terms = join(app.home, 'terms.log')
    const pids: number[] = []
    try {
      const exec = (processId: string, script: string) => {
        app
          .call('command/exec', {
            processId,
            command: ['sh', '-c', script],
            cwd: app.home,
            streamStdoutStderr: true,
            disableTimeout: true,
          })
          .catch(() => {})
        return app.waitFor(() =>
          printedPids(app, 'command/exec/outputDelta', 'processId', processId),
        )
      }
      const loop = 'echo $$; while :; do sleep 0.1; done'
      pids.push(...(await exec('ignores', `trap "" TERM; ${loop}`)))
      pids.push(...(await exec('counts', `trap "echo TERM >> '${terms}'" TERM; ${loop}`)))
      // A terminal without a pty, with a child of its own.
      await app.request('process/spawn', {
        processHandle: 'terminal',
        command: ['sh', '-c', 'sleep 300 & echo $$ $!; wait'],
        cwd: app.home,
        streamStdoutStderr: true,
        streamStdin: true,
      })
      pids.push(
        ...(await app.waitFor(() =>
          printedPids(app, 'process/outputDelta', 'processHandle', 'terminal'),
        )),
      )

      const started = Date.now()
      await app.server.stop()
      const stopMs = Date.now() - started
      const running: number[] = []
      for (const pid of pids) if (!(await exits(pid, 1_000))) running.push(pid)
      // As the transport closes, its clients disconnect.
      app.server.closePeer({ id: 'app', send: () => {}, close: () => {} })
      await delay(300)
      const termCount = readFileSync(terms, 'utf8').split('\n').filter(Boolean).length
      assert.deepEqual({ running, termCount }, { running: [], termCount: 1 })
      assert.ok(stopMs < 10_000, `stop() took ${stopMs} ms`)
    } finally {
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

// A stdio client's pipe closing disconnects it before the adapter stops, and a
// unix or ws client can disconnect just before a launchd stop: stop() still
// waits for the SIGKILL that the disconnect's stop owes.
test('stopping the server waits for the stops a disconnect started', {
  timeout: 20_000,
}, async (t) => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    let pid = 0
    try {
      app
        .call('command/exec', {
          processId: 'ignores',
          command: ['sh', '-c', 'trap "" TERM; echo $$; while :; do sleep 0.1; done'],
          cwd: app.home,
          streamStdoutStderr: true,
          disableTimeout: true,
        })
        .catch(() => {})
      pid =
        (
          await app.waitFor(() =>
            printedPids(app, 'command/exec/outputDelta', 'processId', 'ignores'),
          )
        )[0] ?? 0
      const signalled: unknown[] = []
      const kill = process.kill
      t.mock.method(process, 'kill', (target: number, signal?: string | number) => {
        if (Math.abs(target) === pid) signalled.push([target, signal])
        return kill.call(process, target, signal)
      })

      app.server.closePeer({ id: 'app', send: () => {}, close: () => {} })
      await app.server.stop()

      assert.deepEqual(signalled, [
        [-pid, 'SIGTERM'],
        [-pid, 'SIGKILL'],
      ])
      assert.ok(await exits(pid, 1_000), `process ${pid} outlived the server`)
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

// The pids a process printed first, as `echo $$ [$!]` prints them.
function printedPids(
  app: InProcessApp,
  method: string,
  key: string,
  id: string,
): number[] | undefined {
  const printed = app
    .notified(method)
    .filter((delta) => delta[key] === id)
    .map((delta) => Buffer.from(delta.deltaBase64, 'base64').toString('utf8'))
    .join('')
  const found = /^(\d+)(?: (\d+))?\n/.exec(printed)
  return found ? found.slice(1).filter(Boolean).map(Number) : undefined
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
