import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { type InProcessApp, scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// thread/delete ends what runs in a chat and in the subagent threads it
// spawned before their rows go, and nothing starts there meanwhile. No turn
// of a deleted thread keeps the adapter busy, and the App hears nothing more
// of a thread it was told is gone.

// Every run (a turn, a review, a compaction's summary) streams a little and
// waits for the test to release it; an interrupt only records the thread.
function holdingRuntime() {
  const interrupts: string[] = []
  const releases = new Map<string, () => void>()
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
      await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
      await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
    },
    {
      interrupt: async (threadId) => {
        interrupts.push(threadId)
      },
    },
  )
  const releaseAll = (): void => {
    for (const release of releases.values()) release()
  }
  return { runtime, interrupts, releases, releaseAll }
}

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

async function subagentThread(app: InProcessApp, parent: string): Promise<string> {
  return (await app.request('thread/fork', { threadId: parent, threadSource: 'subagent' })).thread
    .id
}

// What the App heard of a thread after its thread/deleted.
function heardAfterDelete(app: InProcessApp, threadId: string): string[] {
  const heard = app.messages
    .filter((message) => message.method && message.params?.threadId === threadId)
    .map((message) =>
      message.method === 'turn/completed'
        ? `turn/completed(${message.params.turn.status})`
        : message.method,
    )
  assert.ok(heard.includes('thread/deleted'), `${threadId} was deleted`)
  return heard.slice(heard.indexOf('thread/deleted') + 1)
}

test('deleting a chat interrupts a turn the user runs on its subagent thread', async () => {
  const { runtime, interrupts, releases, releaseAll } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    const child = await subagentThread(app, parent)
    const turnId = await app.startTurn(child, 'a question for the agent itself')
    await app.waitFor(() => releases.get(turnId))

    assert.deepEqual(await app.request('thread/delete', { threadId: parent }), {})
    assert.deepEqual(interrupts, [child])
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
    assert.equal(app.store.getThread(child), null)
    assert.equal(app.server.hasActiveTurns(), false)

    // The run returns after its thread went.
    releaseAll()
    await delay(200)
    assert.equal(app.server.hasActiveTurns(), false)
    assert.deepEqual(heardAfterDelete(app, child), [])
  })
})

test('nothing starts on a chat or its subagent threads while thread/delete stops them', async () => {
  const { runtime, releases, releaseAll } = holdingRuntime()
  let releaseInterrupt!: () => void
  const interrupted = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  runtime.interrupt = () => interrupted
  runtime.hasPendingContinuation = () => true
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const child = await subagentThread(app, threadId)
    const turnId = await app.startTurn(threadId, 'take your time')
    await app.waitFor(() => releases.get(turnId))
    const deleting = app.call('thread/delete', { threadId })
    // The delete now waits for the runtime to stop the turn.
    await app.turnCompleted(turnId)

    for (const id of [threadId, child]) {
      for (const [method, params] of [
        ['turn/start', { input: text('hi') }],
        ['review/start', { target: { type: 'uncommittedChanges' }, delivery: 'inline' }],
        ['thread/compact/start', {}],
        ['thread/shellCommand', { command: 'true' }],
      ] as const) {
        const reply = await app.call(method, { threadId: id, ...params })
        assert.match(reply.error?.message ?? 'accepted', /unknown thread/, `${method} on ${id}`)
      }
      // Nor does Claude's answer to a background agent open a turn there.
      runtime.listener?.onAutonomousTurn(id)
    }
    releaseInterrupt()
    assert.deepEqual((await deleting).result, {})

    releaseAll()
    await delay(200)
    assert.equal(app.notified('turn/started').length, 1)
    assert.equal(app.server.hasActiveTurns(), false)
    assert.deepEqual(heardAfterDelete(app, threadId), [])
    assert.deepEqual(heardAfterDelete(app, child), [])
  })
})

test('a compaction thread/delete interrupts does not complete after its thread is gone', async () => {
  const { runtime, releases, releaseAll } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    await app.request('thread/compact/start', { threadId })
    const turnId = await app.waitFor(() => app.notified('turn/started')[0]?.turn.id)
    await app.waitFor(() => releases.get(turnId))

    await app.request('thread/delete', { threadId })
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
    releaseAll()
    await delay(200)
    assert.deepEqual(heardAfterDelete(app, threadId), [])
    assert.equal(app.server.hasActiveTurns(), false)
  })
})

test('a run or user shell whose turn left the store lets go of its thread', async () => {
  const { runtime, releases, releaseAll } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const chat = await app.startThread()
    const turnId = await app.startTurn(chat, 'take your time')
    const compacting = await app.startThread()
    await app.request('thread/compact/start', { threadId: compacting })
    const compactTurnId = await app.waitFor(
      () => app.notified('turn/started').find((params) => params.threadId === compacting)?.turn.id,
    )
    await app.waitFor(() => releases.get(turnId) && releases.get(compactTurnId))
    // A `!` command on its own is a turn too; it runs until the test says.
    const shelling = await app.startThread({ cwd: app.home })
    await app.request('thread/shellCommand', {
      threadId: shelling,
      command: 'while [ ! -e go ]; do sleep 0.02; done',
      timeoutMs: 30_000,
    })

    // However the rows went, no run or shell has a turn left to end when it
    // returns, and none may keep the adapter busy.
    app.store.deleteThread(chat)
    app.store.deleteThread(compacting)
    app.store.deleteThread(shelling)
    releaseAll()
    await writeFile(join(app.home, 'go'), '')
    await app.waitFor(() => (app.server.hasActiveTurns() ? undefined : true))
    await delay(100)
    assert.deepEqual(app.notified('turn/completed'), [])
    assert.deepEqual(
      app.notified('item/completed').filter((params) => params.threadId === shelling),
      [],
    )
  })
})

test('a turn, review or compaction started just before thread/delete never runs', async () => {
  const { runtime, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    for (const [method, params] of [
      ['turn/start', { input: text('hi') }],
      ['review/start', { target: { type: 'uncommittedChanges' }, delivery: 'inline' }],
      ['thread/compact/start', {}],
    ] as const) {
      const threadId = await app.startThread()
      // The App deletes the chat before the adapter got to announce the
      // turn and start Claude for it.
      await app.request(method, { threadId, ...params })
      assert.deepEqual(await app.request('thread/delete', { threadId }), {})
      await delay(100)
      assert.deepEqual(heardAfterDelete(app, threadId), [], method)
      assert.deepEqual(
        app.notified('turn/started').filter((started) => started.threadId === threadId),
        [],
        method,
      )
    }
    assert.equal(releases.size, 0, 'no Claude run started')
    assert.equal(app.server.hasActiveTurns(), false)
  })
})

test('a queued message on a subagent thread goes with its deleted chat', async () => {
  const { runtime, releases, releaseAll } = holdingRuntime()
  let releaseInterrupt!: () => void
  const interrupted = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  runtime.interrupt = () => interrupted
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const child = await subagentThread(app, threadId)
    const turnId = await app.startTurn(threadId, 'take your time')
    const childTurnId = await app.startTurn(child, 'a question for the agent itself')
    await app.waitFor(() => releases.get(turnId) && releases.get(childTurnId))
    await app.request('thread/queue/add', { threadId: child, input: text('and then this') })
    const deleting = app.call('thread/delete', { threadId })
    // The delete now waits for the runtime to stop the chat's turn, and the
    // agent thread's own turn ends meanwhile.
    await app.turnCompleted(turnId)
    releases.get(childTurnId)?.()
    assert.equal((await app.turnCompleted(childTurnId)).status, 'completed')
    await delay(100)
    releaseInterrupt()
    assert.deepEqual((await deleting).result, {})

    releaseAll()
    await delay(100)
    // The queued message went with the thread, unsent and without an error.
    assert.deepEqual(app.notified('error'), [])
    assert.equal(app.notified('turn/started').length, 2)
    assert.deepEqual(heardAfterDelete(app, child), [])
    assert.equal(app.server.hasActiveTurns(), false)
  })
})
