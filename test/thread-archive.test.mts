import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// thread/archive puts a chat away the way Codex does: what still runs in it
// ends, and the subagent threads it spawned go with it.

// Each turn launches one background agent (task bg-task) and ends, leaving
// the agent running.
function backgroundAgentRuntime() {
  const stops: string[] = []
  const resets: string[] = []
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'agent-bg',
        toolName: 'Agent',
        input: { description: 'Background', prompt: 'survey', run_in_background: true },
      })
      await runtime.listener?.onTaskEvent(context.threadId, {
        type: 'task_started',
        taskId: 'bg-task',
        toolUseId: 'agent-bg',
        taskType: 'local_agent',
        description: 'Background',
        subagentType: null,
        prompt: 'survey',
        backgrounded: true,
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: 'agent-bg',
        content: 'Async agent launched successfully.\nagentId: bg-task',
        structured: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'bg-task',
          prompt: 'survey',
        },
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
    },
    {
      stopTask: async (_threadId, taskId) => {
        stops.push(taskId)
        return true
      },
      resetSession: (threadId) => {
        resets.push(threadId)
      },
      hasPendingContinuation: () => true,
    },
  )
  return { runtime, stops, resets }
}

test('archiving a chat stops its background agents and archives its subagent threads, not its forks', async () => {
  const { runtime, stops, resets } = backgroundAgentRuntime()
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    await app.turnCompleted(await app.startTurn(parent, 'launch an agent'))
    const child = app
      .notified('thread/started')
      .map((params) => params.thread.id)
      .find((id) => id !== parent)
    assert.ok(child, 'the background agent has its own thread')
    assert.equal(app.store.listTurns(child).at(-1)?.status, 'inProgress')
    const { thread: fork } = await app.request('thread/fork', { threadId: parent })

    assert.deepEqual(await app.request('thread/archive', { threadId: parent }), {})
    assert.deepEqual(stops, ['bg-task'])
    assert.equal(app.store.listTurns(child).at(-1)?.status, 'interrupted')
    assert.equal(app.store.getThread(parent)?.archived, true)
    assert.equal(app.store.getThread(child)?.archived, true)
    assert.deepEqual(
      app
        .notified('thread/archived')
        .map((params) => params.threadId)
        .toSorted(),
      [parent, child].toSorted(),
    )
    // Its Claude session closes; a later turn resumes it.
    assert.ok(resets.includes(parent))
    // A fork is a chat of its own.
    assert.equal(app.store.getThread(fork.id)?.archived, false)

    // Claude answering the stopped agent opens no turn in the archived chat.
    const started = app.notified('turn/started').length
    runtime.listener?.onAutonomousTurn(parent)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(app.notified('turn/started').length, started)

    const { thread } = await app.request('thread/unarchive', { threadId: parent })
    assert.equal(thread.id, parent)
    assert.equal(app.store.getThread(parent)?.archived, false)
    assert.equal(app.store.getThread(child)?.archived, false)
    assert.deepEqual(
      app
        .notified('thread/unarchived')
        .map((params) => params.threadId)
        .toSorted(),
      [parent, child].toSorted(),
    )
  })
})

test('archiving a chat mid-turn interrupts its turn', async () => {
  const interrupts: string[] = []
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = scriptedRuntime(
    async (_context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
      started()
      await released
      await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
    },
    {
      interrupt: async (threadId) => {
        interrupts.push(threadId)
        release()
      },
    },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'take your time')
    await running
    await app.request('thread/archive', { threadId })
    assert.deepEqual(interrupts, [threadId])
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
    assert.equal(app.store.getThread(threadId)?.archived, true)
  })
})
