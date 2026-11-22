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

    // A title, in a thread of its own.
    const title = await app.startThread({ ephemeral: true })
    assert.equal((await run(title, { outputSchema: TITLE_SCHEMA })).persistSession, false)

    // A description fork still starts from the chat's session.
    const described = await run(await fork({ ephemeral: true }), { outputSchema: TITLE_SCHEMA })
    assert.equal(described.persistSession, false)
    assert.equal(described.claudeSessionId, `session-${chat}`)
    assert.equal(described.forkSession, true)

    const kept = await run(await fork({}))
    assert.equal(persists(kept), true)
    assert.equal(kept.forkSession, true)

    // A subagent thread is ephemeral, but its own turns are the user's.
    const agent = await run(await fork({ ephemeral: true, threadSource: 'subagent' }))
    assert.equal(persists(agent), true)
  })
})
