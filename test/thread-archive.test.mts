import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeHandlers } from '../src/types.mjs'
import {
  type ScriptedRuntime,
  scriptedRuntime,
  withInProcessApp,
} from './fixtures/in-process-app.mjs'

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

test('archiving a chat interrupts a turn the user runs on its subagent thread', async () => {
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
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    const { thread: child } = await app.request('thread/fork', {
      threadId: parent,
      threadSource: 'subagent',
    })
    const turnId = await app.startTurn(child.id, 'a question for the agent itself')
    await app.waitFor(() => releases.get(turnId))

    await app.request('thread/archive', { threadId: parent })
    assert.deepEqual(interrupts, [child.id])
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
    assert.equal(app.store.getThread(child.id)?.archived, true)
    assert.equal(app.server.hasActiveTurns(), false)
    // The run returning later does not complete the turn after all.
    releases.get(turnId)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(app.store.getTurn(turnId)?.status, 'interrupted')

    // Nor does a review or compaction start in the archived thread.
    for (const [method, params] of [
      ['review/start', { target: { type: 'uncommittedChanges' } }],
      ['thread/compact/start', {}],
    ] as const) {
      const reply = await app.call(method, { threadId: child.id, ...params })
      assert.match(reply.error?.message ?? 'accepted', /archived thread/, method)
    }
  })
})

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

// Claude launches background agent `name` (its task id too) in the turn.
async function launchAgent(
  runtime: ScriptedRuntime,
  threadId: string,
  handlers: RuntimeHandlers,
  name: string,
): Promise<void> {
  await handlers.onEvent({
    type: 'tool_use',
    toolUseId: `agent-${name}`,
    toolName: 'Agent',
    input: { description: name, prompt: 'survey', run_in_background: true },
  })
  await runtime.listener?.onTaskEvent(threadId, {
    type: 'task_started',
    taskId: name,
    toolUseId: `agent-${name}`,
    taskType: 'local_agent',
    description: name,
    subagentType: null,
    prompt: 'survey',
    backgrounded: true,
  })
  await handlers.onEvent({
    type: 'tool_result',
    toolUseId: `agent-${name}`,
    content: `Async agent launched successfully.\nagentId: ${name}`,
    structured: { isAsync: true, status: 'async_launched', agentId: name, prompt: 'survey' },
  })
}

test('nothing starts in a chat or its subagent threads while thread/archive stops them', async () => {
  const releases = new Map<string, () => void>()
  let releaseInterrupt!: () => void
  const interrupted = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
      await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
      await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
    },
    { interrupt: () => interrupted, hasPendingContinuation: () => true },
  )
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread({ cwd: app.home })
    const { thread: child } = await app.request('thread/fork', {
      threadId: parent,
      threadSource: 'subagent',
    })
    const turnId = await app.startTurn(child.id, 'a question for the agent itself')
    await app.waitFor(() => releases.get(turnId))
    const archiving = app.call('thread/archive', { threadId: parent })
    // The archive now waits for the runtime to stop the agent thread's turn.
    await app.turnCompleted(turnId)

    for (const id of [parent, child.id]) {
      for (const [method, params] of [
        ['turn/start', { input: text('hi') }],
        ['review/start', { target: { type: 'uncommittedChanges' }, delivery: 'inline' }],
        ['thread/compact/start', {}],
        ['thread/shellCommand', { command: 'true' }],
      ] as const) {
        const reply = await app.call(method, { threadId: id, ...params })
        assert.match(reply.error?.message ?? 'accepted', /being archived/, `${method} on ${id}`)
      }
      // Nor does Claude's answer to a background agent open a turn there.
      runtime.listener?.onAutonomousTurn(id)
    }
    releaseInterrupt()
    assert.deepEqual((await archiving).result, {})

    for (const release of releases.values()) release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(app.notified('turn/started').length, 1)
    assert.equal(app.server.hasActiveTurns(), false)
    assert.equal(app.store.getThread(parent)?.archived, true)
  })
})

test('archiving a chat ends its turns before its background agents', async () => {
  // The chat's turn leaves an agent running (bg-root). The user's own turn on
  // a subagent thread launches one (bg-child) once the test says.
  const stops: string[] = []
  let stopRootAgent!: () => void
  const rootAgentStop = new Promise<void>((resolve) => {
    stopRootAgent = resolve
  })
  let launchChildAgent!: () => void
  const childAgentLaunch = new Promise<void>((resolve) => {
    launchChildAgent = resolve
  })
  let childAgentLaunched!: () => void
  const childAgentLaunchDone = new Promise<void>((resolve) => {
    childAgentLaunched = resolve
  })
  let parent = ''
  const releases: Array<() => void> = []
  const runtime: ScriptedRuntime = scriptedRuntime(
    async (context, handlers) => {
      if (context.threadId === parent) {
        await launchAgent(runtime, context.threadId, handlers, 'bg-root')
        await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
        return
      }
      await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
      await childAgentLaunch
      await launchAgent(runtime, context.threadId, handlers, 'bg-child')
      childAgentLaunched()
      await new Promise<void>((resolve) => releases.push(resolve))
      await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
    },
    {
      stopTask: async (_threadId, taskId) => {
        stops.push(taskId)
        if (taskId === 'bg-root') await rootAgentStop
        return true
      },
    },
  )
  await withInProcessApp(runtime, async (app) => {
    parent = await app.startThread()
    await app.turnCompleted(await app.startTurn(parent, 'launch an agent'))
    const { thread: child } = await app.request('thread/fork', {
      threadId: parent,
      threadSource: 'subagent',
    })
    const turnId = await app.startTurn(child.id, 'a question for the agent itself')
    await app.waitFor(() =>
      app.notified('item/agentMessage/delta').find((d) => d.turnId === turnId),
    )

    const archiving = app.call('thread/archive', { threadId: parent })
    // While the chat's agent takes its time to stop, the agent thread's turn
    // tries to launch one of its own.
    await app.waitFor(() => (stops.includes('bg-root') ? true : undefined))
    launchChildAgent()
    await childAgentLaunchDone
    stopRootAgent()
    assert.deepEqual((await archiving).result, {})
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')

    // Nothing is left running in the archived chat.
    assert.equal(app.server.hasActiveTurns(), false)
    for (const id of app.store.subagentTreeIds(parent)) {
      assert.equal(app.store.getThread(id)?.archived, true)
      assert.notEqual(app.store.listTurns(id).at(-1)?.status, 'inProgress', id)
    }
    for (const release of releases) release()
  })
})

test('archiving or deleting a chat ends a turn on an agent thread whose agent the chat resumed meanwhile', async () => {
  for (const method of ['thread/archive', 'thread/delete']) {
    const stops: string[] = []
    const interrupts: string[] = []
    const releases = new Map<string, () => void>()
    let parent = ''
    const runtime: ScriptedRuntime = scriptedRuntime(
      async (context, handlers) => {
        if (context.threadId === parent && /launch an agent/.test(context.prompt)) {
          await launchAgent(runtime, parent, handlers, 'bg')
        } else if (context.threadId === parent) {
          // Claude messages the agent, which resumes in the background.
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'send-bg',
            toolName: 'SendMessage',
            input: { to: 'bg', message: 'dig deeper' },
          })
          await handlers.onEvent({
            type: 'tool_result',
            toolUseId: 'send-bg',
            content: 'Agent "bg" was resumed in the background.',
          })
        } else {
          await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
          await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
        }
        await handlers.onEvent({ type: 'completed', success: true, result: 'Done.' })
      },
      {
        stopTask: async (_threadId, taskId) => {
          stops.push(taskId)
          return true
        },
        interrupt: async (threadId) => {
          interrupts.push(threadId)
        },
      },
    )
    await withInProcessApp(runtime, async (app) => {
      parent = await app.startThread()
      await app.turnCompleted(await app.startTurn(parent, 'launch an agent'))
      const agentThread = app
        .notified('thread/started')
        .map((params) => params.thread.id)
        .find((id) => id !== parent)
      assert.ok(agentThread, 'the agent has its own thread')
      // The agent reports and is done.
      await runtime.listener?.onTaskEvent(parent, {
        type: 'task_notification',
        taskId: 'bg',
        toolUseId: 'agent-bg',
        status: 'completed',
        summary: 'Agent "bg" completed',
        result: 'report',
        usage: null,
      })
      assert.equal(app.store.listTurns(agentThread).at(-1)?.status, 'completed')
      // The user talks to the agent on its thread, and meanwhile the chat
      // messages the agent, which runs again.
      const turnId = await app.startTurn(agentThread, 'a question for the agent itself')
      await app.waitFor(() => releases.get(turnId))
      await app.turnCompleted(await app.startTurn(parent, 'message the agent'))

      assert.deepEqual(await app.request(method, { threadId: parent }), {})
      assert.deepEqual(stops, ['bg'], method)
      assert.deepEqual(interrupts, [agentThread], method)
      assert.equal((await app.turnCompleted(turnId)).status, 'interrupted', method)
      assert.equal(app.server.hasActiveTurns(), false, method)
      for (const release of releases.values()) release()
    })
  }
})

test('a second archive or delete of a chat waits for the first, which keeps the chat closed meanwhile', async () => {
  for (const [method, refusal] of [
    ['thread/archive', /being archived/],
    ['thread/delete', /unknown thread/],
  ] as const) {
    const releases = new Map<string, () => void>()
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const runtime = scriptedRuntime(
      async (context, handlers) => {
        await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
        await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
        await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
      },
      { interrupt: () => interrupted },
    )
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread()
      const turnId = await app.startTurn(threadId, 'take your time')
      await app.waitFor(() => releases.get(turnId))
      const first = app.call(method, { threadId })
      // The first now waits for the runtime to stop the turn; the second
      // finds nothing left to stop.
      await app.turnCompleted(turnId)
      const second = app.call(method, { threadId })
      const early = await Promise.race([
        second.then(() => 'second done'),
        new Promise((resolve) => setTimeout(() => resolve('second waits'), 100)),
      ])
      assert.equal(early, 'second waits', method)
      const reply = await app.call('turn/start', { threadId, input: text('hi') })
      assert.match(reply.error?.message ?? 'accepted', refusal, method)

      releaseInterrupt()
      assert.deepEqual((await first).result, {}, method)
      assert.deepEqual((await second).result, {}, method)
      for (const release of releases.values()) release()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(app.notified('turn/started').length, 1, method)
      assert.equal(app.server.hasActiveTurns(), false, method)
    })
  }
})

test('a message queued on a subagent thread stays queued while thread/archive stops the chat', async () => {
  const releases = new Map<string, () => void>()
  let releaseInterrupt!: () => void
  const interrupted = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: 'Working. ' })
      await new Promise<void>((resolve) => releases.set(context.turnId, resolve))
      await handlers.onEvent({ type: 'completed', success: true, result: 'Working. Done.' })
    },
    { interrupt: () => interrupted },
  )
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    const { thread: child } = await app.request('thread/fork', {
      threadId: parent,
      threadSource: 'subagent',
    })
    const turnId = await app.startTurn(parent, 'take your time')
    const childTurnId = await app.startTurn(child.id, 'a question for the agent itself')
    await app.waitFor(() => releases.get(turnId) && releases.get(childTurnId))
    await app.request('thread/queue/add', { threadId: child.id, input: text('and then this') })
    const archiving = app.call('thread/archive', { threadId: parent })
    // The archive now waits for the runtime to stop the chat's turn, and the
    // agent thread's own turn ends meanwhile.
    await app.turnCompleted(turnId)
    releases.get(childTurnId)?.()
    assert.equal((await app.turnCompleted(childTurnId)).status, 'completed')
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseInterrupt()
    assert.deepEqual((await archiving).result, {})

    // The message waits in the archived thread's queue; nothing failed.
    assert.deepEqual(app.notified('error'), [])
    assert.equal(app.notified('turn/started').length, 2)
    assert.equal(app.store.listQueue(child.id).length, 1)
    assert.equal(app.server.hasActiveTurns(), false)
  })
})
