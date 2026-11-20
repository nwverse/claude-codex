import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ClaudeRuntime } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// The adapter keeps background agents that already reported back, so a
// SendMessage that comes later reopens them as they ran. A daemon that never
// restarts must not keep every one it ever ran.

// MAX_FINISHED_BACKGROUND_AGENTS in server.mts.
const KEPT = 256

// What the adapter keeps of one (BackgroundSubagent in server.mts).
interface KnownAgent {
  parentThreadId: string
  toolUseId: string
  taskId: string | null
  agentId: string | null
  running: boolean
  context: { childThreadId: string; childTurnId: string; prompt: string }
}

// Each turn launches background agents task-0 and task-1 ('launch'), or
// sends both a message ('message').
function backgroundAgentsRuntime(extra: Partial<ClaudeRuntime> = {}) {
  const runtime = scriptedRuntime(async (context, handlers) => {
    for (const i of [0, 1]) {
      if (context.prompt === 'launch') {
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: `agent-${i}`,
          toolName: 'Agent',
          input: { description: `Agent ${i}`, prompt: `survey ${i}`, run_in_background: true },
        })
        await runtime.listener?.onTaskEvent(context.threadId, {
          type: 'task_started',
          taskId: `task-${i}`,
          toolUseId: `agent-${i}`,
          taskType: 'local_agent',
          description: `Agent ${i}`,
          subagentType: null,
          prompt: `survey ${i}`,
          backgrounded: true,
        })
        await handlers.onEvent({
          type: 'tool_result',
          toolUseId: `agent-${i}`,
          content: `Async agent launched successfully.\nagentId: task-${i}`,
          structured: { isAsync: true, status: 'async_launched', agentId: `task-${i}` },
        })
      } else {
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: `send-${i}`,
          toolName: 'SendMessage',
          input: { to: `task-${i}`, message: 'dig deeper' },
        })
        await handlers.onEvent({ type: 'tool_result', toolUseId: `send-${i}`, content: 'Sent.' })
      }
    }
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }, extra)
  return runtime
}

const knownAgents = (server: object) =>
  Reflect.get(server, 'backgroundSubagents') as Map<string, KnownAgent>

test('only the most recently finished background agents stay known, and SendMessage still reopens an older one', async () => {
  const runtime = backgroundAgentsRuntime()
  const report = (threadId: string, i: number) =>
    runtime.listener?.onTaskEvent(threadId, {
      type: 'task_notification',
      taskId: `task-${i}`,
      toolUseId: `agent-${i}`,
      status: 'completed',
      summary: `Agent ${i}`,
      result: `report ${i}`,
      usage: null,
    })
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    await app.turnCompleted(await app.startTurn(parent, 'launch'))
    const [first, second] = app
      .notified('item/completed')
      .filter((params) => params.item.tool === 'spawnAgent')
      .map((params) => String(params.item.receiverThreadIds[0]))
    assert.ok(first && second)
    // A page of agents the parent launched after the first: SendMessage looks
    // for an agent it no longer knows by name, not among the newest 200.
    const template = app.store.getThread(first)
    assert.ok(template)
    app.store.transaction(() => {
      for (let i = 0; i < 200; i += 1) {
        const id = randomUUID()
        app.store.upsertThread({
          ...template,
          id,
          sessionId: id,
          agentNickname: `later-${i}`,
          createdAt: template.createdAt + 1,
        })
      }
    })

    await report(parent, 0)
    // As many agents as the adapter keeps (another chat's) finish after the
    // first one ...
    const known = knownAgents(app.server)
    const finished = known.get(first)
    assert.ok(finished)
    const another = (id: string, running: boolean): KnownAgent => ({
      ...finished,
      parentThreadId: 'another-chat',
      toolUseId: id,
      taskId: id,
      agentId: id,
      running,
      context: { ...finished.context, childThreadId: id, childTurnId: id },
    })
    for (let i = 0; i < KEPT; i += 1) known.set(`other-${i}`, another(`other-${i}`, false))
    // Agents still running stay, however many finished, also ahead of them.
    const entries = [...known]
    known.clear()
    for (let i = 0; i < 3; i += 1) known.set(`running-${i}`, another(`running-${i}`, true))
    for (const [id, entry] of entries) known.set(id, entry)
    // ... and one more pushes it out, with the next oldest that no SendMessage
    // is on its way to.
    const pending = Reflect.get(app.server, 'pendingAgentCalls') as Map<string, unknown>
    pending.set('send-other', {
      tool: 'sendInput',
      itemId: 'send-other-item',
      childThreadId: 'other-0',
      message: '',
    })
    await report(parent, 1)
    pending.delete('send-other')
    const running = [...known].filter(([, entry]) => entry.running).map(([id]) => id)
    assert.deepEqual(running, ['running-0', 'running-1', 'running-2'])
    for (const id of running) known.delete(id)
    assert.equal(known.size, KEPT)
    assert.equal(known.has(first), false)
    assert.equal(known.has('other-0'), true)
    assert.equal(known.has('other-1'), false)
    assert.equal([...known.keys()].at(-1), second)
    // The child turn holds the prompt; the entry no longer does.
    assert.equal(known.get(second)?.context.prompt, '')
    assert.equal(app.store.listTurns(second).at(-1)?.status, 'completed')

    const from = app.messages.length
    await app.turnCompleted(await app.startTurn(parent, 'message'))
    const sent = app.messages.slice(from)
    assert.deepEqual(
      sent
        .filter(
          (message) =>
            message.method === 'item/completed' && message.params.item.tool === 'sendInput',
        )
        .map((message) => message.params.item.receiverThreadIds),
      [[first], [second]],
    )
    for (const child of [first, second]) {
      assert.ok(
        sent.some(
          (message) => message.method === 'turn/started' && message.params.threadId === child,
        ),
        'the message reopens the child thread',
      )
      assert.equal(app.store.listTurns(child).at(-1)?.status, 'inProgress')
    }
  })
})

// thread/delete forgets the agents of the threads it deletes. A stop that
// was still on its way to one settles it, and must not bring it back.
test('a stop that settles an agent the adapter already forgot leaves it forgotten', async () => {
  let stopCalled = false
  let finishStop!: (stopped: boolean) => void
  const runtime = backgroundAgentsRuntime({
    stopTask: () => {
      stopCalled = true
      return new Promise<boolean>((resolve) => {
        finishStop = resolve
      })
    },
  })
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread()
    await app.turnCompleted(await app.startTurn(parent, 'launch'))
    const [child] = app
      .notified('item/completed')
      .filter((params) => params.item.tool === 'spawnAgent')
      .map((params) => String(params.item.receiverThreadIds[0]))
    assert.ok(child)
    const known = knownAgents(app.server)
    assert.equal(known.get(child)?.running, true)

    // The user stops the agent from its thread; the CLI takes its time.
    const stopping = app.request('turn/interrupt', { threadId: child })
    await app.waitFor(() => (stopCalled ? true : undefined))
    known.delete(child)
    finishStop(true)
    await stopping
    assert.equal(app.store.listTurns(child).at(-1)?.status, 'interrupted')
    assert.equal(known.has(child), false)
  })
})
