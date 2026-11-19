import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('thread shell commands emit a standalone turn and item lifecycle but hide the item in history', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      assert.deepEqual(
        await app.request('thread/shellCommand', {
          threadId,
          command: 'printf shell-output; printf shell-error >&2; exit 3',
          timeoutMs: null,
        }),
        {},
      )
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      const item = completed.item
      assert.equal(completed.threadId, threadId)
      assert.equal(item.type, 'commandExecution')
      assert.equal(item.processId, null)
      assert.equal(item.exitCode, 3)
      assert.equal(item.status, 'failed')
      assert.equal(item.cwd, app.home)
      assert.match(item.aggregatedOutput, /shell-output/)
      assert.match(item.aggregatedOutput, /shell-error/)
      assert.equal(typeof item.durationMs, 'number')
      assert.ok(item.durationMs >= 0)
      const started = app.notified('item/started').find((event) => event.item.id === item.id)
      assert.equal(started.item.status, 'inProgress')
      assert.equal(started.item.source, 'userShell')
      assert.equal(started.turnId, completed.turnId)
      const deltas = app
        .notified('item/commandExecution/outputDelta')
        .filter((event) => event.itemId === item.id)
      assert.ok(deltas.length > 0)
      assert.ok(
        deltas.every((event) => event.threadId === threadId && event.turnId === completed.turnId),
      )
      assert.match(deltas.map((event) => event.delta).join(''), /shell-output/)
      const turn = await app.turnCompleted(completed.turnId)
      assert.equal(turn.status, 'completed')
      assert.equal(app.notified('turn/started').length, 1)
      const methods = app.messages
        .filter((message) => message.method)
        .map((message) => message.method)
      assert.ok(methods.indexOf('turn/started') < methods.indexOf('item/started'))
      assert.ok(
        methods.indexOf('item/started') < methods.indexOf('item/commandExecution/outputDelta'),
      )
      assert.ok(
        methods.indexOf('item/commandExecution/outputDelta') < methods.indexOf('item/completed'),
      )
      assert.ok(methods.indexOf('item/completed') < methods.indexOf('turn/completed'))
      const read = await app.request('thread/read', { threadId, includeTurns: true })
      assert.equal(read.thread.turns.length, 1)
      assert.equal(read.thread.turns[0].id, completed.turnId)
      assert.deepEqual(read.thread.turns[0].items, [])
      const listed = await app.request('thread/turns/list', { threadId, itemsView: 'full' })
      assert.equal(listed.data.length, 1)
      assert.deepEqual(listed.data[0].items, [])
      const items = await app.request('thread/items/list', { threadId, turnId: completed.turnId })
      assert.deepEqual(items.data, [])
      const timeline = await app.request('thread/timeline/list', { threadId })
      assert.deepEqual(
        timeline.data.map((entry: { type: string }) => entry.type),
        ['turnStarted', 'turnCompleted'],
      )
      const fork = await app.request('thread/fork', { threadId })
      assert.deepEqual(fork.thread.turns[0].items, [])
    },
  )
})

test('thread shell command timeout reports exit code -1 and settles its turn', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      await app.request('thread/shellCommand', {
        threadId,
        command: 'printf partial-output; exec sleep 30',
        timeoutMs: 1200,
      })
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      assert.equal(completed.item.exitCode, -1)
      assert.match(completed.item.aggregatedOutput, /partial-output[\s\S]*Timeout/)
      assert.match(
        app
          .notified('item/commandExecution/outputDelta')
          .map((p) => p.delta)
          .join(''),
        /Timeout/,
      )

      assert.equal(completed.item.status, 'failed')
      assert.equal((await app.turnCompleted(completed.turnId)).status, 'completed')
    },
  )
})

test('thread shell command rejects unknown threads and invalid timeout before execution', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      for (const timeoutMs of [-1, 1.5, '100', 2 ** 64, Number.NaN, Number.POSITIVE_INFINITY]) {
        const reply = await app.call('thread/shellCommand', {
          threadId,
          command: 'printf ignored',
          timeoutMs,
        })
        assert.equal(reply.error?.code, -32602)
        assert.match(reply.error?.message ?? '', /timeoutMs/)
      }
      for (const command of ['  ', 'word\0word']) {
        const reply = await app.call('thread/shellCommand', { threadId, command })
        assert.equal(reply.error?.code, -32602)
      }
      const unknown = await app.call('thread/shellCommand', {
        threadId: 'missing-thread',
        command: 'printf ignored',
      })
      assert.match(unknown.error?.message ?? '', /unknown thread: missing-thread/)
      assert.equal(app.notified('turn/started').length, 0)
      assert.equal(app.notified('item/started').length, 0)
    },
  )
})

test('thread shell command joins an active turn without completing it', async () => {
  let finishRuntime: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    finishRuntime = resolve
  })
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await running
    await handlers.onEvent({ type: 'completed', success: true })
  })
  await withInProcessApp(runtime, async (app) => {
    try {
      const threadId = await app.startThread({ cwd: app.home })
      const turnId = await app.startTurn(threadId, 'Remain active')
      await app.request('thread/shellCommand', { threadId, command: 'printf joined' })
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      assert.equal(completed.turnId, turnId)
      assert.equal(completed.item.exitCode, 0)
      assert.equal(completed.item.status, 'completed')
      assert.equal(app.notified('turn/started').length, 1)
      assert.equal(app.notified('turn/completed').length, 0)
      finishRuntime()
      assert.equal((await app.turnCompleted(turnId)).status, 'completed')
    } finally {
      finishRuntime()
    }
  })
})

test('server shutdown stops an active user shell and releases its idle hold', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      await app.request('thread/shellCommand', {
        threadId,
        command: 'printf "%s" "$$"; exec sleep 30',
      })
      const started = await app.waitFor(() =>
        app.notified('item/started').find((event) => event.item.source === 'userShell'),
      )
      const pid = await app.waitFor(() => {
        const output = app
          .notified('item/commandExecution/outputDelta')
          .map((p) => p.delta)
          .join('')
        return Number(output) > 0 ? Number(output) : undefined
      })
      assert.equal(app.server.hasActiveTurns(), true)
      await app.server.stop()
      assert.equal(app.server.hasActiveTurns(), false)
      await app.waitFor(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
          throw error
        }
      })
      const reopened = new SessionStore(join(app.home, 'state.sqlite'))
      try {
        const turn = reopened.getTurn(started.turnId)
        assert.equal(turn?.status, 'interrupted')
        const item = turn?.items.find((item) => item.type === 'commandExecution')
        assert.equal(item?.status, 'failed')
        assert.equal(item?.exitCode, -1)
      } finally {
        reopened.close()
      }
    },
  )
})

test('shell input is closed and large output is bounded on the wire and in the store', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      await writeFile(join(app.home, 'fixture.txt'), 'large 文本🌍\n'.repeat(90_000))
      const threadId = await app.startThread({ cwd: app.home })
      await app.request('thread/shellCommand', {
        threadId,
        command: 'cat; cat fixture.txt; exit 7',
        timeoutMs: 10_000,
      })
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((p) => p.item.source === 'userShell'),
      )
      assert.equal(completed.item.exitCode, 7)
      const output = completed.item.aggregatedOutput
      assert.ok(Buffer.byteLength(output) <= 1_000_000 && Buffer.byteLength(output) > 990_000)
      assert.ok(!output.includes('�'))
      assert.equal(
        app
          .notified('item/commandExecution/outputDelta')
          .map((p) => p.delta)
          .join(''),
        output,
      )
      const stored = app.store
        .getTurn(completed.turnId)
        ?.items.find((item) => item.type === 'commandExecution')
      assert.equal(stored?.aggregatedOutput, output)
    },
  )
})

for (const joined of [false, true]) {
  test(`interrupt closes the ${joined ? 'joined' : 'standalone'} shell before completing the turn once`, async () => {
    let finishRuntime = () => {}
    const running = new Promise<void>((resolve) => {
      finishRuntime = resolve
    })
    const runtime = scriptedRuntime(
      async (_ctx, handlers) => {
        await running
        await handlers.onEvent({ type: 'completed', success: true })
      },
      { interrupt: async () => finishRuntime() },
    )
    await withInProcessApp(runtime, async (app) => {
      try {
        const threadId = await app.startThread({ cwd: app.home })
        const active = joined ? await app.startTurn(threadId, 'Wait for interrupt') : null
        await app.request('thread/shellCommand', {
          threadId,
          command: 'printf "%s" "$$"; exec sleep 30',
        })
        const pid = await app.waitFor(
          () =>
            Number(app.notified('item/commandExecution/outputDelta').at(-1)?.delta) || undefined,
        )
        const started = app.notified('item/started').find((p) => p.item.source === 'userShell')
        if (active) assert.equal(started.turnId, active)
        else {
          const competing = await app.call('turn/start', {
            threadId,
            input: [{ type: 'text', text: 'new turn' }],
          })
          assert.ok(competing.error)
          assert.equal(app.notified('turn/started').length, 1)
        }
        await app.request('turn/interrupt', { threadId, turnId: started.turnId })
        assert.equal((await app.turnCompleted(started.turnId)).status, 'interrupted')
        const completed = app.notified('item/completed').find((p) => p.item.source === 'userShell')
        assert.equal(completed.item.exitCode, -1)
        assert.match(completed.item.aggregatedOutput, /command aborted by user/)
        const itemEnd = app.messages.findIndex(
          (m) => m.method === 'item/completed' && m.params.item.id === started.item.id,
        )
        const turnEnd = app.messages.findIndex(
          (m) => m.method === 'turn/completed' && m.params.turn.id === started.turnId,
        )
        assert.ok(itemEnd >= 0 && itemEnd < turnEnd)
        await app.waitFor(() => {
          try {
            process.kill(pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
            throw error
          }
          return undefined
        })
        assert.equal(app.store.getTurn(started.turnId)?.status, 'interrupted')
        assert.equal(
          app.notified('turn/completed').filter((p) => p.turn.id === started.turnId).length,
          1,
        )
      } finally {
        finishRuntime()
      }
    })
  })
}

test('ending a runtime turn waits for a joined command before sending turn/completed', async () => {
  let finishRuntime = () => {}
  const running = new Promise<void>((resolve) => {
    finishRuntime = resolve
  })
  const runtime = scriptedRuntime(async (_ctx, handlers) => {
    await running
    await handlers.onEvent({ type: 'completed', success: true })
  })
  await withInProcessApp(runtime, async (app) => {
    try {
      const threadId = await app.startThread({ cwd: app.home })
      const turnId = await app.startTurn(threadId, 'wait for shell')
      await app.request('thread/shellCommand', {
        threadId,
        command: 'printf ready; while [ ! -f proceed ]; do sleep 0.05; done; printf done',
      })
      await app.waitFor(() =>
        app.notified('item/commandExecution/outputDelta').find((p) => p.delta.includes('ready')),
      )
      finishRuntime()
      await writeFile(join(app.home, 'proceed'), '')
      await app.turnCompleted(turnId)
      const end = app.messages.findIndex(
        (m) => m.method === 'item/completed' && m.params.item.source === 'userShell',
      )
      const turnEnd = app.messages.findIndex(
        (m) => m.method === 'turn/completed' && m.params.turn.id === turnId,
      )
      assert.ok(end >= 0 && end < turnEnd)
      assert.equal(app.messages[end].params.item.aggregatedOutput, 'readydone')
    } finally {
      finishRuntime()
    }
  })
})

for (const method of ['thread/archive', 'thread/delete']) {
  test(`${method} aborts a running shell before removing its thread`, async () => {
    await withInProcessApp(
      scriptedRuntime(async () => {}),
      async (app) => {
        const threadId = await app.startThread({ cwd: app.home })
        await app.request('thread/shellCommand', { threadId, command: 'exec sleep 30' })
        const start = app.notified('item/started').find((p) => p.item.source === 'userShell')
        await app.request(method, { threadId })
        assert.equal((await app.turnCompleted(start.turnId)).status, 'interrupted')
        const item = app.notified('item/completed').find((p) => p.item.id === start.item.id)
        assert.equal(item.item.exitCode, -1)
        assert.equal(app.server.hasActiveTurns(), false)
        if (method === 'thread/archive') {
          assert.equal(app.store.getThread(threadId)?.archived, true)
          assert.equal(app.store.getTurn(start.turnId)?.status, 'interrupted')
        } else assert.equal(app.store.getThread(threadId), null)
      },
    )
  })
}
