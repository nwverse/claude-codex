import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord, TurnRecord } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

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
      cwd: process.cwd(),
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

test('a second adapter process cannot start a review or compaction on a running thread', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const a = spawnTurnServer(home, true)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: process.cwd(),
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

    await delay(200)
    assert.equal(readModelRuns(home).length, 1, 'the second process never ran the model')
    assert.equal(
      b.messages.some((message) => message.method === 'turn/started'),
      false,
    )
    const store = new SessionStore(join(home, 'state.sqlite'))
    try {
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
          cwd: process.cwd(),
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
      // What a live server whose `ps` failed writes for its turns.
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
    cwd: process.cwd(),
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
    diff: '',
    error: null,
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

function spawnTurnServer(home: string, hold: boolean): FixtureClient {
  const proc = spawn(process.execPath, [fixture], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODEX_HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_TEST_HOME: home,
      CLAUDE_CODEX_TEST_HOLD_TURN: hold ? '1' : '0',
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
