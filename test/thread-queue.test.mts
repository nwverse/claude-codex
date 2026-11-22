import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, ThreadItem, ThreadRecord, TurnStatus } from '../src/types.mjs'
import { type InProcessApp, scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

// Turns whose prompt starts with "[hold]" run until the test releases them (or
// they are interrupted); every other turn answers at once.
function holdingRuntime(extra: Partial<ClaudeRuntime> = {}) {
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
      ...extra,
    },
  )
  return { runtime, prompts, releases }
}

// The server's in-memory queue holds, by thread.
const queueHolds = (app: InProcessApp) =>
  (app.server as unknown as { queueHolds: Map<string, boolean> }).queueHolds

test('a queued message started after a turn keeps the adapter busy until its own turn ends', async () => {
  const { runtime, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    // What the daemon's idle exit sees each time the server says it may be idle.
    const idleChecks: boolean[] = []
    app.server.setIdleCheckHandler(() => idleChecks.push(app.server.hasActiveTurns()))
    const threadId = await app.startThread()
    const first = await app.startTurn(threadId, '[hold] first')
    const releaseFirst = await app.waitFor(() => releases.get(first))
    const { queuedSubmission } = await app.request('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: '[hold] queued' }],
    })
    assert.deepEqual(queuedSubmission.input, text('[hold] queued'))
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

test('a shell command, review or compaction after an interrupt leaves the queue held, after a restart too', async () => {
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
    // A restarted adapter has only the stored turns to go by, the newest of
    // them not the user's.
    queueHolds(app).clear()
    await runSideTurn('thread/shellCommand', { command: 'true' })
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

test('turns on a helper thread leave no queue hold behind', async () => {
  const { runtime, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    await app.turnCompleted(await app.startTurn(threadId, 'a chat'))
    // Title, description and summary threads are never archived or deleted.
    const helperId = await app.startThread({ ephemeral: true })
    await app.turnCompleted(await app.startTurn(helperId, 'a title'))
    const stopped = await app.startTurn(helperId, '[hold] a summary the user stops')
    await app.waitFor(() => releases.get(stopped))
    await app.request('turn/interrupt', { threadId: helperId, turnId: stopped })
    await app.turnCompleted(stopped)
    assert.deepEqual([...queueHolds(app).keys()], [threadId])
  })
})

// A chat in a state database of its own, as a restarted adapter reads it.
// Each added turn starts after the one before.
async function storedChat(
  body: (chat: {
    store: SessionStore
    path: string
    held: () => boolean
    addTurn: (status: TurnStatus, ...items: Array<Record<string, unknown>>) => string
  }) => void,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-queue-hold-'))
  const path = join(home, 'state.sqlite')
  const store = new SessionStore(path)
  const threadId = 'chat'
  store.upsertThread({
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    preview: 'queue hold',
    name: null,
    archived: false,
    cwd: home,
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    runtimeBackend: 'claude',
    codexSessionId: null,
  } as ThreadRecord)
  let turns = 0
  try {
    body({
      store,
      path,
      held: () => store.interruptedSinceUserTurn(threadId),
      addTurn: (status, ...items) => {
        turns += 1
        const id = `turn-${turns}`
        store.upsertTurn({
          id,
          threadId,
          status,
          startedAt: turns,
          completedAt: status === 'inProgress' ? null : turns,
          durationMs: null,
          items: items.map((item, index) => ({ id: `${id}-${index}`, ...item }) as ThreadItem),
          error: null,
        })
        return id
      },
    })
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

const userMessage = { type: 'userMessage', content: text('do it') }
const answer = { type: 'agentMessage', text: 'done' }
const shell = {
  type: 'commandExecution',
  command: 'true',
  source: 'userShell',
  status: 'completed',
}
const compaction = { type: 'contextCompaction' }

test("the stored turns hold the queue from an interrupt until the user's next turn", async () => {
  await storedChat(({ store, path, held, addTurn }) => {
    assert.equal(held(), false, 'a chat with no turns')
    addTurn('completed', userMessage, answer)
    assert.equal(held(), false)
    addTurn('interrupted', userMessage, answer)
    assert.equal(held(), true)
    // A shell command, a review, a compaction, Claude's own follow-up or a
    // goal continuation, a failed one too, leaves the hold as it was.
    addTurn('completed', shell)
    addTurn('completed', userMessage, { type: 'enteredReviewMode', review: 'changes' }, answer)
    addTurn('completed', compaction)
    addTurn('completed', answer)
    addTurn('failed')
    assert.equal(held(), true)
    // A tool's output the client sends as a turn is the user's own.
    addTurn('completed', { type: 'functionCallOutput', callId: 'call', output: 'ok' }, answer)
    assert.equal(held(), false)
    // A failed turn of the user's releases a hold and never sets one.
    addTurn('interrupted', userMessage)
    addTurn('failed', userMessage)
    assert.equal(held(), false)

    // A side turn a server stop ends is stored interrupted and holds.
    store.completeTurn(addTurn('inProgress', shell), 'interrupted', { message: 'server stopped' })
    assert.equal(held(), true)
    addTurn('completed', userMessage, answer)
    assert.equal(held(), false)
    // So does one a crash left running, once a restart recovers it.
    const crashed = addTurn('inProgress', compaction)
    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE turns SET owner_pid = NULL, owner_started = NULL WHERE id = ?').run(
        crashed,
      )
    } finally {
      db.close()
    }
    assert.equal(held(), false, 'a running side turn')
    assert.equal(store.recoverStaleInProgressTurns(), 1)
    assert.equal(held(), true)
  })
})

test("a turn whose items SQLite cannot parse counts as the user's own", async () => {
  await storedChat(({ held, addTurn }) => {
    // JSON.parse reads nesting deeper than SQLite's limit of 1000.
    let result: unknown = 'deep'
    for (let depth = 0; depth < 1100; depth += 1) result = [result]
    const deepCall = { type: 'mcpToolCall', server: 's', tool: 't', status: 'completed', result }
    addTurn('interrupted', userMessage)
    addTurn('completed', userMessage, deepCall, answer)
    assert.equal(held(), false)
    addTurn('interrupted', userMessage, deepCall)
    assert.equal(held(), true)
    // Even a side turn's: it may release a hold, never keep one.
    addTurn('completed', deepCall)
    assert.equal(held(), false)
  })
})

test('a hold the stored turns cannot give comes from the newest turn', async () => {
  const { runtime, prompts, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, '[hold] until the user stops this')
    await app.waitFor(() => releases.get(turnId))
    await app.request('thread/queue/add', { threadId, input: text('held message') })
    await app.request('turn/interrupt', { threadId, turnId })
    queueHolds(app).clear()
    app.store.interruptedSinceUserTurn = () => {
      throw new Error('malformed JSON')
    }
    // Adding to the queue reads the hold: it neither fails nor sends.
    await app.request('thread/queue/add', { threadId, input: text('second message') })
    await delay(100)
    assert.equal((await app.request('thread/queue/list', { threadId })).data.length, 2)
    assert.equal(
      prompts.some((prompt) => prompt.includes('message')),
      false,
    )
  })
})

// A dispatch that passed the idle check, as startFollowUp's does, before a
// turn of this process became active.
const dispatchQueued = (app: InProcessApp, threadId: string, submission: unknown) => {
  const server = app.server as unknown as {
    dispatchQueued(peer: unknown, threadId: string, submission: unknown): Promise<unknown>
    peerForThread(threadId: string): unknown
  }
  return server.dispatchQueued(server.peerForThread(threadId), threadId, submission)
}

test('a queued message never joins a running turn, so it runs once, as its own turn', async () => {
  const steered: string[] = []
  // A runtime that takes steering, so joining the running turn would succeed.
  const { runtime, prompts, releases } = holdingRuntime({
    steer: async (_threadId, prompt) => {
      steered.push(prompt)
      return true
    },
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const first = await app.startTurn(threadId, '[hold] first')
    const releaseFirst = await app.waitFor(() => releases.get(first))
    await app.request('thread/queue/add', { threadId, input: text('queued once') })
    const [head] = app.store.listQueue(threadId)
    assert.ok(head)
    await assert.rejects(dispatchQueued(app, threadId, head), /already has an active turn/)
    assert.deepEqual(steered, [])
    assert.deepEqual(
      app.store.listQueue(threadId).map((entry) => entry.id),
      [head.id],
    )

    releaseFirst()
    await app.turnCompleted(first)
    await app.waitFor(() =>
      prompts.some((prompt) => prompt.includes('queued once')) ? true : undefined,
    )
    await app.waitFor(() => (app.server.hasActiveTurns() ? undefined : true))
    await delay(50)
    assert.equal(prompts.filter((prompt) => prompt.includes('queued once')).length, 1)
    assert.deepEqual(app.store.listQueue(threadId), [])
  })
})

test('a queued message edited while its turn starts runs as edited', async () => {
  const { runtime, prompts, releases } = holdingRuntime()
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, '[hold] until the user stops this')
    await app.waitFor(() => releases.get(turnId))
    const { queuedSubmission } = await app.request('thread/queue/add', {
      threadId,
      input: text('old text'),
    })
    await app.request('turn/interrupt', { threadId, turnId })
    await app.turnCompleted(turnId)
    // The dispatch read the message before this edit landed.
    const [stale] = app.store.listQueue(threadId)
    await app.request('thread/queue/update', {
      threadId,
      queuedSubmissionId: queuedSubmission.id,
      input: text('new text'),
    })

    await dispatchQueued(app, threadId, stale)
    await app.waitFor(() =>
      prompts.some((prompt) => prompt.includes('new text')) ? true : undefined,
    )
    await app.waitFor(() => (app.server.hasActiveTurns() ? undefined : true))
    assert.equal(
      prompts.some((prompt) => prompt.includes('old text')),
      false,
    )
    assert.deepEqual(app.store.listQueue(threadId), [])
  })
})
