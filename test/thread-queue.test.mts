import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

// Turns whose prompt starts with "[hold]" run until the test releases them (or
// they are interrupted); every other turn answers at once.
function holdingRuntime() {
  const prompts: string[] = []
  const releases = new Map<string, () => void>()
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      prompts.push(context.prompt)
      if (context.prompt.startsWith('[hold]')) {
        await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
      }
      await handlers.onEvent({ type: 'text_delta', delta: 'done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    {
      interrupt: async () => {
        for (const release of releases.values()) release()
      },
    },
  )
  return { runtime, prompts, releases }
}

test('a queued message started after a turn keeps the adapter busy until its own turn ends', async () => {
  const { runtime, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    // What the daemon's idle exit sees each time the server says it may be idle.
    const idleChecks: boolean[] = []
    app.server.setIdleCheckHandler(() => idleChecks.push(app.server.hasActiveTurns()))
    const threadId = await app.startThread()
    const first = await app.startTurn(threadId, '[hold] first')
    const releaseFirst = await app.waitFor(() => releases.get(first))
    await app.request('thread/queue/add', { threadId, input: text('[hold] queued') })
    releaseFirst()
    await app.turnCompleted(first)

    // The queued message's turn is claimed across an await; the adapter must
    // not look idle in between.
    const queued = await app.waitFor(() => [...releases.keys()].find((turnId) => turnId !== first))
    assert.deepEqual(idleChecks, [], 'nothing reported idle while the queued turn started')
    assert.equal(app.server.hasActiveTurns(), true)

    releases.get(queued)?.()
    await app.turnCompleted(queued)
    await app.waitFor(() => (idleChecks.at(-1) === false ? true : undefined))
  })
})

test('a shell command, review or compaction after an interrupt leaves the queue held', async () => {
  const { runtime, prompts, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread({ cwd: app.home })
    const turnId = await app.startTurn(threadId, '[hold] until the user stops this')
    await app.waitFor(() => releases.get(turnId))
    const { queuedSubmission } = await app.request('thread/queue/add', {
      threadId,
      input: text('held message'),
    })
    await app.request('turn/interrupt', { threadId, turnId })

    const runSideTurn = async (method: string, params: Record<string, unknown>) => {
      const ended = app.notified('turn/completed').length
      await app.request(method, { threadId, ...params })
      await app.waitFor(() => (app.notified('turn/completed').length > ended ? true : undefined))
    }
    await runSideTurn('thread/shellCommand', { command: 'true' })
    await runSideTurn('review/start', { target: { type: 'uncommittedChanges' } })
    await runSideTurn('thread/compact/start', {})
    // A follow-up would have started within a tick of the last one ending.
    await delay(100)
    const held = await app.request('thread/queue/list', { threadId })
    assert.deepEqual(
      held.data.map((entry: { id: string }) => entry.id),
      [queuedSubmission.id],
    )
    assert.equal(
      prompts.some((prompt) => prompt.includes('held message')),
      false,
    )

    // The user's own next turn lets the queue go on after it.
    await app.turnCompleted(await app.startTurn(threadId, 'carry on'))
    await app.waitFor(() =>
      prompts.some((prompt) => prompt.includes('held message')) ? true : undefined,
    )
    await app.waitFor(() => (app.server.hasActiveTurns() ? undefined : true))
    assert.deepEqual((await app.request('thread/queue/list', { threadId })).data, [])
  })
})
