import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord, TurnRecord } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

process.env.CLAUDE_CODEX_DEBUG_LOG = '0'

const fixture = resolve('dist/test/fixtures/cross-process-turn-server.mjs')
const storeModule = resolve('dist/src/store.mjs')

interface FixtureClient {
  proc: ChildProcessWithoutNullStreams
  messages: any[]
  stderr: string
  nextId: number
}

test('two adapter processes exclude duplicate turns and recover a crashed owner', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const a = spawnTurnServer(home, true)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: home,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    assert.equal(started.error, undefined, started.error?.message)
    const threadId = started.result.thread.id as string

    b = spawnTurnServer(home, false)
    const resumed = await call(b, 'thread/resume', { threadId })
    assert.equal(resumed.error, undefined, resumed.error?.message)

    const first = await call(a, 'turn/start', {
      threadId,
      input: textInput('first process owns the turn'),
    })
    assert.equal(first.error, undefined, first.error?.message)
    const firstTurnId = first.result.turn.id as string
    await waitFor(() => readModelRuns(home).length === 1, 'the first model run')

    const rejected = await call(b, 'turn/start', {
      threadId,
      input: textInput('duplicate from the second process'),
    })
    assert.ok(rejected.error, 'the second process must reject the duplicate turn')
    assert.match(rejected.error.message, /another adapter process/)
    assert.equal(rejected.result, undefined)
    assert.equal(readModelRuns(home).length, 1, 'the second process never ran the model')
    assert.equal(
      b.messages.some((message) => message.method === 'turn/started'),
      false,
      'the rejected request emitted no turn lifecycle',
    )

    let store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turns = store.listTurns(threadId)
      assert.equal(turns.length, 1, 'the rejected request persisted no second turn')
      assert.equal(store.getThread(threadId)?.status.type, 'active')
      assert.equal(turns[0]?.id, firstTurnId)
      assert.equal(
        turns[0]?.items.filter((item) => item.type === 'userMessage').length,
        1,
        'the user item was persisted exactly once',
      )
    } finally {
      store.close()
    }

    a.proc.kill('SIGKILL')
    await once(a.proc, 'exit')
    assert.equal(a.proc.signalCode, 'SIGKILL')

    const recovered = await call(b, 'turn/start', {
      threadId,
      input: textInput('replacement after the owner crash'),
    })
    assert.equal(recovered.error, undefined, recovered.error?.message)
    const recoveredTurnId = recovered.result.turn.id as string
    assert.notEqual(recoveredTurnId, firstTurnId)
    await waitFor(
      () =>
        b?.messages.find(
          (message) =>
            message.method === 'turn/completed' && message.params.turn.id === recoveredTurnId,
        ),
      'the recovered turn to complete',
    )

    const runs = readModelRuns(home)
    assert.equal(runs.length, 2, 'one crashed run and one recovered run, with no duplicate')
    assert.deepEqual(
      runs.map((run) => run.turnId),
      [firstTurnId, recoveredTurnId],
    )

    store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turns = store.listTurns(threadId)
      assert.equal(turns.length, 2, 'the rejected request remains absent after recovery')
      assert.equal(turns.find((turn) => turn.id === firstTurnId)?.status, 'interrupted')
      assert.match(
        String((turns.find((turn) => turn.id === firstTurnId)?.error as any)?.message),
        /owner exited/,
      )
      assert.equal(turns.find((turn) => turn.id === recoveredTurnId)?.status, 'completed')
      assert.equal(
        turns.some((turn) => turn.status === 'inProgress'),
        false,
      )
      const userTexts = userMessageTexts(turns)
      assert.deepEqual(
        new Set(userTexts),
        new Set(['first process owns the turn', 'replacement after the owner crash']),
      )
    } finally {
      store.close()
    }
  } finally {
    await writeFile(join(home, 'release-turn'), 'release', { flag: 'w' }).catch(() => {})
    await Promise.all([stopProcess(a), ...(b ? [stopProcess(b)] : [])])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('pipelined in-process turn starts still join the first turn', async () => {
  let modelRuns = 0
  let release = (): void => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = scriptedRuntime(
    async (_context, handlers) => {
      modelRuns += 1
      await handlers.onEvent({ type: 'text_delta', delta: 'holding' })
      await released
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    {
      steer: async (_threadId, _prompt, options) => {
        options?.onAccepted?.()
        release()
        return true
      },
    },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const [first, pipelined] = await Promise.all([
      app.call('turn/start', { threadId, input: textInput('first pipelined input') }),
      app.call('turn/start', { threadId, input: textInput('second pipelined input') }),
    ])
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    assert.equal(pipelined.error, undefined, JSON.stringify(pipelined.error))
    const turnId = first.result.turn.id as string
    assert.equal(pipelined.result.turn.id, turnId)
    await app.turnCompleted(turnId)
    assert.equal(modelRuns, 1)
    const turns = app.store.listTurns(threadId)
    assert.equal(turns.length, 1)
    const userTexts = userMessageTexts(turns)
    assert.deepEqual(userTexts, ['first pipelined input', 'second pipelined input'])
  })
})

test('a concurrent session update survives a turn claim and its rejected turn is rolled back', async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({ type: 'completed', success: true, result: 'ok' })
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const claim = app.store.claimTurn.bind(app.store)
    app.store.claimTurn = (turn, onClaim) => {
      app.store.updateClaudeSessionId(threadId, 'session-from-other-adapter')
      return claim(turn, onClaim)
    }
    const reply = await app.call('turn/start', { threadId, input: textInput('hello') })
    assert.match(reply.error?.message ?? '', /thread changed/)
    const saved = app.store.getThread(threadId)
    assert.equal(saved?.claudeSessionId, 'session-from-other-adapter')
    assert.equal(saved?.preview, '')
    assert.deepEqual(app.store.listTurns(threadId), [])
    app.store.claimTurn = claim
    await app.turnCompleted(await app.startTurn(threadId, 'retry'))
  })
})

test('input to the thread of a running background agent is not blamed on another process', async () => {
  const runtime = scriptedRuntime(async (context, handlers) => {
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
      structured: { isAsync: true, status: 'async_launched', agentId: 'bg-task', prompt: 'survey' },
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
  })
  await withInProcessApp(runtime, async (app) => {
    const parent = await app.startThread({ cwd: app.home })
    await app.turnCompleted(await app.startTurn(parent, 'launch an agent'))
    const child = app
      .notified('thread/started')
      .map((params) => params.thread.id)
      .find((id) => id !== parent)
    assert.ok(child)
    // The agent's own turn on its thread is this process's, though no turn
    // of the server runs there.
    for (const [method, params] of [
      ['turn/start', { input: textInput('how is it going?') }],
      ['thread/shellCommand', { command: 'true' }],
      ['review/start', { target: { type: 'uncommittedChanges' } }],
    ] as const) {
      const reply = await app.call(method, { threadId: child, ...params })
      assert.match(reply.error?.message ?? '', /this agent is still working/, method)
    }
  })
})

test('a second adapter cannot replace, rewind, interrupt, or archive an active turn', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const a = spawnTurnServer(home, true)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: home,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    assert.equal(started.error, undefined, started.error?.message)
    const threadId = started.result.thread.id as string
    b = spawnTurnServer(home, false)
    const resumed = await call(b, 'thread/resume', { threadId })
    assert.equal(resumed.error, undefined, resumed.error?.message)

    const first = await call(a, 'turn/start', {
      threadId,
      input: textInput('first process owns the turn'),
    })
    assert.equal(first.error, undefined, first.error?.message)
    await waitFor(() => readModelRuns(home).length === 1, 'the first model run')

    const review = await call(b, 'review/start', {
      threadId,
      target: { type: 'uncommittedChanges' },
    })
    assert.ok(review.error, 'the second process must reject the review')
    assert.match(review.error.message, /another adapter process/)
    const compact = await call(b, 'thread/compact/start', { threadId })
    assert.ok(compact.error, 'the second process must reject the compaction')
    assert.match(compact.error.message, /another adapter process/)

    for (const [method, extra] of [
      ['thread/shellCommand', { command: 'echo unmanaged' }],
      ['thread/rollback', { numTurns: 1 }],
      ['thread/revert', { beforeTurnId: first.result.turn.id }],
      ['turn/interrupt', { turnId: first.result.turn.id }],
      ['thread/archive', {}],
      ['thread/delete', {}],
    ] as const) {
      const response = await call(b, method, { threadId, ...extra })
      assert.match(response.error?.message ?? '', /another adapter process/, method)
    }

    await delay(200)
    assert.equal(readModelRuns(home).length, 1, 'the second process never ran the model')
    assert.equal(
      b.messages.some((message) => message.method === 'turn/started'),
      false,
    )
    const store = new SessionStore(join(home, 'state.sqlite'))
    try {
      assert.equal(store.updateThreadStatus(threadId, { type: 'idle' }), false)
      assert.equal(store.getThread(threadId)?.status.type, 'active')
      assert.deepEqual(
        store.listTurns(threadId).map((turn) => turn.id),
        [first.result.turn.id],
      )
    } finally {
      store.close()
    }
  } finally {
    await writeFile(join(home, 'release-turn'), 'release', { flag: 'w' }).catch(() => {})
    await Promise.all([stopProcess(a), ...(b ? [stopProcess(b)] : [])])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('input waiting to join a turn whose end the store refused claims the next turn', {
  timeout: 20_000,
}, async () => {
  const runs: string[] = []
  let releaseRun = (): void => {}
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let steerCalls = 0
  let releaseSteer = (): void => {}
  const steerGate = new Promise<void>((resolve) => {
    releaseSteer = resolve
  })
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      runs.push(context.turnId)
      await handlers.onEvent({ type: 'text_delta', delta: 'holding' })
      if (runs.length === 1) await runGate
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    {
      steer: async () => {
        steerCalls += 1
        await steerGate
        // The turn this input waited on has ended meanwhile.
        return false
      },
    },
  )
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      const first = await app.request('turn/start', {
        threadId,
        input: textInput('first input'),
      })
      const firstTurnId = first.turn.id as string
      await app.waitFor(() => (runs.length === 1 ? true : undefined))

      const pipelined = app.call('turn/start', {
        threadId,
        input: textInput('input that waited to join'),
      })
      await app.waitFor(() => (steerCalls === 1 ? true : undefined))

      // The first turn ends while the store refuses its terminal write; its
      // row stays inProgress until the delayed retry runs.
      const release = holdStateDatabase(join(app.home, 'state.sqlite'))
      try {
        releaseRun()
        await app.turnCompleted(firstTurnId)
      } finally {
        release()
      }
      assert.equal(app.store.getTurn(firstTurnId)?.status, 'inProgress')

      releaseSteer()
      const reply = await pipelined
      assert.equal(reply.error, undefined, JSON.stringify(reply.error))
      const nextTurnId = reply.result.turn.id as string
      assert.notEqual(nextTurnId, firstTurnId)
      await app.turnCompleted(nextTurnId)
      assert.deepEqual(runs, [firstTurnId, nextTurnId])
      const firstStored = app.store.getTurn(firstTurnId)
      assert.notEqual(firstStored?.status, 'inProgress')
      assert.notEqual(firstStored?.status, 'interrupted', 'the refused outcome is kept')
      assert.deepEqual(userMessageTexts(app.store.listTurns(threadId)), [
        'first input',
        'input that waited to join',
      ])
    },
    { env: { CLAUDE_CODEX_STATE_DB_TIMEOUT_MS: '50' } },
  )
})

test('claiming over a dead owner settles its items and keeps its owner', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const path = join(home, 'state.sqlite')
  const threadId = 'dead-owner-thread'
  const deadTurnId = 'dead-owner-turn'
  const store = new SessionStore(path)
  try {
    store.upsertThread(threadRecord(threadId))
    const owner = await writeTurnFromExitedProcess(home, path, {
      ...turnRecord(threadId, deadTurnId),
      items: [
        {
          type: 'commandExecution',
          id: 'running-command',
          command: 'sleep 60',
          cwd: home,
          processId: null,
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        } as any,
      ],
    })

    const claim = store.claimTurn(turnRecord(threadId, 'replacement-turn'))
    assert.equal(claim.claimed, true)
    const settled = store.getTurn(deadTurnId)
    assert.equal(settled?.status, 'interrupted')
    assert.equal(
      (settled?.items[0] as any)?.status,
      'failed',
      'an item the dead owner left running is settled like startup recovery does',
    )
    const db = new DatabaseSync(path)
    try {
      const row = db.prepare('SELECT owner_pid FROM turns WHERE id = ?').get(deadTurnId) as {
        owner_pid: number
      }
      assert.equal(row.owner_pid, owner, 'the settled turn still names the process that ran it')
    } finally {
      db.close()
    }
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a claim never displaces an in-progress turn without owner metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const path = join(home, 'state.sqlite')
  const threadId = 'unowned-thread'
  const store = new SessionStore(path)
  try {
    store.upsertThread(threadRecord(threadId))
    store.upsertTurn(turnRecord(threadId, 'unowned-turn'))
    const db = new DatabaseSync(path)
    try {
      // Older adapters without a usable ps wrote no owner at all.
      db.prepare('UPDATE turns SET owner_pid = NULL, owner_started = NULL WHERE id = ?').run(
        'unowned-turn',
      )
    } finally {
      db.close()
    }
    const claim = store.claimTurn(turnRecord(threadId, 'competing-turn'))
    assert.equal(claim.claimed, false)
    assert.equal(claim.claimed === false && claim.activeTurn.id, 'unowned-turn')
    assert.equal(store.getTurn('unowned-turn')?.status, 'inProgress')
    assert.equal(store.getTurn('competing-turn'), null)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a claim never displaces a live owner whose start time ps cannot read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const path = join(home, 'state.sqlite')
  const threadId = 'ps-failure-thread'
  const store = new SessionStore(path)
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const savedPath = process.env.PATH
  try {
    store.upsertThread(threadRecord(threadId))
    store.upsertTurn(turnRecord(threadId, 'live-owner-turn'))
    const db = new DatabaseSync(path)
    try {
      // A live process; its recorded start time differs from the real one, so
      // only a failed ps lookup can make it look alive.
      db.prepare('UPDATE turns SET owner_pid = ?, owner_started = ? WHERE id = ?').run(
        owner.pid as number,
        'Mon Jan  1 00:00:00 2001',
        'live-owner-turn',
      )
    } finally {
      db.close()
    }
    // Adapters on a platform without process start times still record the
    // pid. Opening another adapter must leave that live pid's turn alone.
    const raw = new DatabaseSync(path)
    try {
      raw.prepare('UPDATE turns SET owner_started = NULL WHERE id = ?').run('live-owner-turn')
      assert.equal(store.recoverStaleInProgressTurns(), 0)
      assert.equal(store.claimTurn(turnRecord(threadId, 'unknown-start')).claimed, false)
      raw
        .prepare('UPDATE turns SET owner_started = ? WHERE id = ?')
        .run('Mon Jan  1 00:00:00 2001', 'live-owner-turn')
    } finally {
      raw.close()
    }
    // A ps that fails, as when it times out or cannot run.
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    process.env.PATH = `${bin}:${savedPath}`
    const claim = store.claimTurn(turnRecord(threadId, 'competing-turn'))
    assert.equal(claim.claimed, false)
    assert.equal(claim.claimed === false && claim.activeTurn.id, 'live-owner-turn')
    assert.equal(store.getTurn('live-owner-turn')?.status, 'inProgress')
    assert.equal(store.getTurn('competing-turn'), null)

    // With ps working again the same mismatched start time is a dead owner.
    process.env.PATH = savedPath
    assert.equal(store.claimTurn(turnRecord(threadId, 'second-try')).claimed, true)
    assert.equal(store.getTurn('live-owner-turn')?.status, 'interrupted')
  } finally {
    process.env.PATH = savedPath
    owner.kill()
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('two adapter processes preserve simultaneous queue additions', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-queue-'))
  const a = spawnTurnServer(home, false)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: home,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    assert.equal(started.error, undefined, started.error?.message)
    const threadId = started.result.thread.id as string
    b = spawnTurnServer(home, false)
    const resumed = await call(b, 'thread/resume', { threadId })
    assert.equal(resumed.error, undefined, resumed.error?.message)
    seedQueueHold(home, threadId)
    await writeFile(join(home, 'queue-barrier-armed'), 'armed')

    const first = call(a, 'thread/queue/add', {
      threadId,
      input: textInput('simultaneous add from A'),
    })
    const second = call(b, 'thread/queue/add', {
      threadId,
      input: textInput('simultaneous add from B'),
    })
    await releaseQueueReadBarrier(home, [a, b])
    const [firstReply, secondReply] = await Promise.all([first, second])
    assert.equal(firstReply.error, undefined, firstReply.error?.message)
    assert.equal(secondReply.error, undefined, secondReply.error?.message)

    const store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const queued = store.listQueue(threadId)
      assert.equal(queued.length, 2, 'both RPC-successful submissions survive')
      assert.deepEqual(queued.map((entry) => (entry.input[0] as any).text).sort(), [
        'simultaneous add from A',
        'simultaneous add from B',
      ])
    } finally {
      store.close()
    }
  } finally {
    await writeFile(join(home, 'release-queue-read'), 'release', { flag: 'w' }).catch(() => {})
    await Promise.all([stopProcess(a), ...(b ? [stopProcess(b)] : [])])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a concurrent queue addition survives dequeue and each submission runs once', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-queue-'))
  // Skip the selecting read in thread/queue/start; pause its dequeue read.
  const a = spawnTurnServer(home, true, 1)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: home,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    assert.equal(started.error, undefined, started.error?.message)
    const threadId = started.result.thread.id as string
    b = spawnTurnServer(home, false)
    const resumed = await call(b, 'thread/resume', { threadId })
    assert.equal(resumed.error, undefined, resumed.error?.message)
    seedQueueHold(home, threadId)
    const queued = await call(a, 'thread/queue/add', {
      threadId,
      input: textInput('queued submission Q'),
    })
    assert.equal(queued.error, undefined, queued.error?.message)
    const qid = queued.result.queuedSubmission.id as string
    await writeFile(join(home, 'queue-barrier-armed'), 'armed')

    const dequeued = call(a, 'thread/queue/start', {
      threadId,
      queuedSubmissionId: qid,
    })
    const added = call(b, 'thread/queue/add', {
      threadId,
      input: textInput('addition concurrent with Q dequeue'),
    })
    await releaseQueueReadBarrier(home, [a, b])
    const [dequeuedReply, addedReply] = await Promise.all([dequeued, added])
    assert.equal(dequeuedReply.error, undefined, dequeuedReply.error?.message)
    assert.equal(addedReply.error, undefined, addedReply.error?.message)
    const addedId = addedReply.result.queuedSubmission.id as string

    let store = new SessionStore(join(home, 'state.sqlite'))
    try {
      assert.deepEqual(
        store.listQueue(threadId).map((entry) => entry.id),
        [addedId],
        'dequeue removes only Q and preserves the successful concurrent addition',
      )
    } finally {
      store.close()
    }

    await writeFile(join(home, 'release-turn'), 'release')
    await waitFor(
      () =>
        a.messages.filter((message) => message.method === 'turn/completed').length === 2
          ? true
          : undefined,
      'Q and the concurrent addition to complete',
      a,
    )
    store = new SessionStore(join(home, 'state.sqlite'))
    try {
      assert.deepEqual(store.listQueue(threadId), [])
      const texts = userMessageTexts(
        store.listTurns(threadId).filter((turn) => turn.id !== 'queue-hold-turn'),
      )
      assert.deepEqual(texts, ['queued submission Q', 'addition concurrent with Q dequeue'])
      assert.equal(texts.filter((text) => text === 'queued submission Q').length, 1)
      assert.equal(readModelRuns(home).length, 2)
    } finally {
      store.close()
    }
  } finally {
    await writeFile(join(home, 'release-turn'), 'release', { flag: 'w' }).catch(() => {})
    await writeFile(join(home, 'release-queue-read'), 'release', { flag: 'w' }).catch(() => {})
    await Promise.all([stopProcess(a), ...(b ? [stopProcess(b)] : [])])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Writes the turn from a separate process that then exits, so the row names
// a real owner that is no longer running. Returns that owner's pid.
async function writeTurnFromExitedProcess(
  home: string,
  path: string,
  turn: TurnRecord,
): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { SessionStore } = await import(${JSON.stringify(storeModule)})
      const store = new SessionStore(${JSON.stringify(path)})
      store.upsertTurn(${JSON.stringify(turn)})
      store.close()`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CLAUDE_CODEX_HOME: home } },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, stderr)
  return child.pid as number
}

function threadRecord(id: string): ThreadRecord {
  const now = Math.floor(Date.now() / 1000) - 2
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: 'claim test',
    name: null,
    archived: false,
    cwd: tmpdir(),
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: now,
    updatedAt: now,
    status: { type: 'active', activeFlags: [] },
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
  } as ThreadRecord
}

function turnRecord(threadId: string, id: string): TurnRecord {
  return {
    id,
    threadId,
    status: 'inProgress',
    startedAt: Math.floor(Date.now() / 1000) - 1,
    completedAt: null,
    durationMs: null,
    items: [],
    error: null,
  }
}

function seedQueueHold(home: string, threadId: string): void {
  const store = new SessionStore(join(home, 'state.sqlite'))
  try {
    store.upsertTurn({
      ...turnRecord(threadId, 'queue-hold-turn'),
      status: 'interrupted',
      completedAt: Math.floor(Date.now() / 1000),
    })
  } finally {
    store.close()
  }
}

async function releaseQueueReadBarrier(home: string, clients: FixtureClient[]): Promise<void> {
  await waitFor(() => {
    const ready = clients.filter((client) =>
      existsSync(join(home, `queue-read-${client.proc.pid}`)),
    ).length
    if (ready === clients.length) return true
    // A transactional implementation holds SQLite's write lock across this
    // read, so the other process cannot reach the barrier until it is released.
    if (ready > 0 && databaseIsWriteLocked(join(home, 'state.sqlite'))) return true
    return undefined
  }, 'both queue readers or a serialized queue writer')
  await writeFile(join(home, 'release-queue-read'), 'release')
}

function databaseIsWriteLocked(path: string): boolean {
  const db = new DatabaseSync(path, { timeout: 1 })
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('ROLLBACK')
    return false
  } catch (error) {
    if (String(error).includes('database is locked')) return true
    throw error
  } finally {
    db.close()
  }
}

// A reader holding the state database, as in adapter.test.mts: until the
// returned release runs, no other connection can commit a write.
function holdStateDatabase(path: string): () => void {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 })
  db.exec('BEGIN')
  db.prepare('SELECT count(*) FROM turns').get()
  return () => {
    db.exec('COMMIT')
    db.close()
  }
}

function spawnTurnServer(home: string, hold: boolean, queueBarrierSkip = 0): FixtureClient {
  const proc = spawn(process.execPath, [fixture], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODEX_HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_TEST_HOME: home,
      CLAUDE_CODEX_TEST_HOLD_TURN: hold ? '1' : '0',
      CLAUDE_CODEX_TEST_QUEUE_BARRIER: '1',
      CLAUDE_CODEX_TEST_QUEUE_BARRIER_SKIP: String(queueBarrierSkip),
      NODE_NO_WARNINGS: '1',
    },
  })
  const client: FixtureClient = { proc, messages: [], stderr: '', nextId: 1 }
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) client.messages.push(JSON.parse(line))
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    client.stderr += chunk
  })
  return client
}

async function call(
  client: FixtureClient,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const id = client.nextId++
  client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return await waitFor(
    () => client.messages.find((message) => message.id === id && message.method === undefined),
    `${method} response`,
    client,
  )
}

async function waitFor<T>(
  find: () => T | undefined,
  description: string,
  client?: FixtureClient,
): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = find()
    if (value !== undefined) return value
    if (client && (client.proc.exitCode !== null || client.proc.signalCode !== null)) {
      throw new Error(`fixture exited while waiting for ${description}: ${client.stderr}`)
    }
    await delay(10)
  }
  throw new Error(`timed out waiting for ${description}${client ? `: ${client.stderr}` : ''}`)
}

function readModelRuns(home: string): Array<{ pid: number; threadId: string; turnId: string }> {
  const path = join(home, 'model-runs.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function userMessageTexts(turns: TurnRecord[]): string[] {
  return turns
    .flatMap((turn) => turn.items)
    .flatMap((item) => {
      if (item.type !== 'userMessage') return []
      const input = item.content[0]
      return input?.type === 'text' ? [input.text] : []
    })
}

function textInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }]
}

async function stopProcess(client: FixtureClient): Promise<void> {
  const proc = client.proc
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill()
  const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
  if (stopped) return
  const killed = once(proc, 'exit')
  proc.kill('SIGKILL')
  await killed
}
