// The App's helper requests (a title, a description fork) run in ephemeral
// threads; their Claude sessions leave no transcript for other tools to list
// as the user's sessions. A chat, a kept fork and a subagent thread the user
// can go on talking to keep theirs.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
}

test('helper threads and forks run without a transcript; chats, kept forks and subagent threads keep one', async () => {
  const contexts = new Map<string, RuntimeTurnContext>()
  const runtime = scriptedRuntime(async (context, handlers) => {
    contexts.set(context.threadId, context)
    await handlers.onEvent({ type: 'session', claudeSessionId: `session-${context.threadId}` })
    await handlers.onEvent({ type: 'text_delta', delta: '{"title":"Hello"}' })
    await handlers.onEvent({ type: 'completed', success: true, result: '{"title":"Hello"}' })
  })
  await withInProcessApp(runtime, async (app) => {
    const run = async (threadId: string, extra: Record<string, unknown> = {}) => {
      const turn = await app.turnCompleted(await app.startTurn(threadId, 'hello', extra))
      assert.equal(turn.status, 'completed')
      const context = contexts.get(threadId)
      assert.ok(context)
      return context
    }
    const persists = (context: RuntimeTurnContext) => context.persistSession !== false

    const chat = await app.startThread()
    assert.equal(Object.hasOwn(await run(chat), 'persistSession'), false)
    const fork = async (params: Record<string, unknown>) =>
      (await app.request('thread/fork', { threadId: chat, ...params })).thread.id as string

    // A title, in a thread of its own. The session it ran in is not recorded,
    // as it left no transcript to resume: a second turn starts from none.
    const title = await app.startThread({ ephemeral: true })
    assert.equal((await run(title, { outputSchema: TITLE_SCHEMA })).persistSession, false)
    assert.equal(app.store.getThread(title)?.claudeSessionId, null)
    const titleAgain = await run(title, { outputSchema: TITLE_SCHEMA })
    assert.equal(titleAgain.persistSession, false)
    assert.equal(titleAgain.claudeSessionId, null)

    // A description fork still starts from the chat's session, and so does
    // each later turn of it: the fork's own session was never written.
    const described = await fork({ ephemeral: true })
    for (let turn = 0; turn < 2; turn++) {
      const context = await run(described, { outputSchema: TITLE_SCHEMA })
      assert.equal(context.persistSession, false)
      assert.equal(context.claudeSessionId, `session-${chat}`)
      assert.equal(context.forkSession, true)
    }
    assert.equal(app.store.getThread(described)?.claudeSessionId, `session-${chat}`)

    // A kept fork records the session its first turn wrote and resumes it.
    const keptId = await fork({})
    const kept = await run(keptId)
    assert.equal(persists(kept), true)
    assert.equal(kept.forkSession, true)
    assert.equal(app.store.getThread(keptId)?.claudeSessionId, `session-${keptId}`)

    // A subagent thread is ephemeral, but its own turns are the user's.
    const agentId = await fork({ ephemeral: true, threadSource: 'subagent' })
    assert.equal(persists(await run(agentId)), true)
    assert.equal(app.store.getThread(agentId)?.claudeSessionId, `session-${agentId}`)
  })
})
