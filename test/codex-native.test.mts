import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { nativeCodexTestEnv } from './support/native-codex-fixture.mjs'

// The native Codex harness: Codex threads run in a real `codex app-server`
// child, here a fake one that answers like codex and logs what it hears.

const adapter = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

class Reader {
  readonly received: any[] = []
  private buffer = ''
  private readonly queue: any[] = []
  private waiter: ((value: any) => void) | null = null
  constructor(proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.push(JSON.parse(line))
        newline = this.buffer.indexOf('\n')
      }
    })
  }
  private push(message: any): void {
    this.received.push(message)
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter(message)
    } else this.queue.push(message)
  }
  next(): Promise<any> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message within 30s')), 30_000)
      this.waiter = (message) => {
        clearTimeout(timer)
        resolve(message)
      }
    })
  }
  // Messages a wait passed over, for later waits: a notification can come
  // before the response of the request that caused it.
  private readonly passed: any[] = []
  async until(done: (message: any) => boolean, seen?: any[]): Promise<any> {
    const index = this.passed.findIndex(done)
    if (index >= 0) {
      if (!seen) return this.passed.splice(index, 1)[0]
      const prefix = this.passed.splice(0, index + 1)
      seen.push(...prefix)
      return prefix.at(-1)
    }
    if (seen) seen.push(...this.passed.splice(0))
    for (let i = 0; i < 500; i += 1) {
      const message = await this.next()
      seen?.push(message)
      if (done(message)) return message
      if (!seen) this.passed.push(message)
    }
    throw new Error('expected message never arrived')
  }
}

function startAdapter(
  options: { home?: string; env?: NodeJS.ProcessEnv; args?: string[]; log?: string } = {},
) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'codex-native-'))
  if (!options.home) dirs.push(home)
  const log = options.log ?? join(home, 'fake.log')
  const proc = spawn(
    process.execPath,
    [adapter, 'app-server', '--listen', 'stdio://', ...(options.args ?? [])],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        ...nativeCodexTestEnv(home, log),
        ...options.env,
      },
    },
  )
  const reader = new Reader(proc)
  let id = 0
  const request = async (method: string, params: unknown) => {
    id += 1
    const requestId = id
    proc.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    return reader.until((message) => message.id === requestId && message.method === undefined)
  }
  const childLog = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const exited = once(proc, 'exit')
    proc.stdin.end()
    await exited
  }
  return { proc, reader, request, childLog, home, stop }
}

async function initialize(app: ReturnType<typeof startAdapter>) {
  await app.request('initialize', {
    clientInfo: { name: 'codex_desktop', version: '26.1013.40934' },
    capabilities: { experimentalApi: true },
  })
}

// Runs a turn on the thread, answering the child's approval with `decision`.
async function runTurn(
  app: ReturnType<typeof startAdapter>,
  threadId: string,
  decision: string,
  extra: Record<string, unknown> = {},
) {
  const started = await app.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hello' }],
    ...extra,
  })
  assert.equal(started.error, undefined, JSON.stringify(started.error))
  const seen: any[] = []
  const approval = await app.reader.until(
    (message) => message.method?.endsWith('requestApproval'),
    seen,
  )
  app.proc.stdin.write(`${JSON.stringify({ id: approval.id, result: { decision } })}\n`)
  await app.reader.until((message) => message.method === 'turn/completed', seen)
  return { approval, seen }
}

test('model/list offers the three harnesses', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const list = await app.request('model/list', {})
    const entries = list.result.data as Array<{ id: string; displayName: string }>
    assert.ok(entries.some((entry) => entry.displayName.startsWith('Claude Code · ')))
    assert.ok(
      entries.some(
        (entry) => entry.id === 'gpt-6.1-sol' && entry.displayName.startsWith('Codex · '),
      ),
    )
    assert.ok(
      entries.some(
        (entry) =>
          entry.id === 'codex-ag:claude-opus-5-5' &&
          entry.displayName.startsWith('Codex+AsterGate · '),
      ),
    )
  } finally {
    await app.stop()
  }
})

test('a Codex+AsterGate chat runs in the child on its provider, approvals round-trip', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', {
      model: 'codex-ag:claude-opus-5-5',
      cwd: app.home,
    })
    const threadId = started.result.thread.id as string
    const { approval, seen } = await runTurn(app, threadId, 'accept')
    assert.match(String(approval.id), /^cx:astergate_claude:\d+:\d+$/)
    assert.equal(approval.params.threadId, threadId)
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.threadId, threadId)
    assert.equal(delta.params.delta, 'astergate_claude:claude-opus-5-5:accept')
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'serverRequest/resolved' && message.params.requestId === approval.id,
      ),
    )

    const childStart = app.childLog().find((entry) => entry.method === 'thread/start')
    assert.equal(childStart.provider, 'astergate_claude')
    assert.equal(childStart.params.model, 'claude-opus-5-5')

    const resumed = await app.request('thread/resume', { threadId })
    assert.equal(resumed.result.thread.id, threadId)
    assert.equal(resumed.result.model, 'codex-ag:claude-opus-5-5')
    assert.equal(resumed.result.modelProvider, 'claude-code')
  } finally {
    await app.stop()
  }
})

test('a GPT chat runs in the ChatGPT child', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', { model: 'gpt-6.1-sol', cwd: app.home })
    const threadId = started.result.thread.id as string
    const { seen } = await runTurn(app, threadId, 'decline')
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.delta, 'openai:gpt-6.1-sol:decline')
  } finally {
    await app.stop()
  }
})

test("a native chat's deferred items and memory summary come from its child", async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', { model: 'gpt-6.1-sol', cwd: app.home })
    const threadId = started.result.thread.id as string
    await runTurn(app, threadId, 'decline')
    for (const [method, params] of [
      ['thread/items/read', { threadId, turnId: 'turn-old', itemIds: ['c1'] }],
      ['thread/memory/read', { threadId }],
    ] as const) {
      const answer = await app.request(method, params)
      assert.equal(answer.error, undefined, `${method}: ${JSON.stringify(answer.error)}`)
      const heard = app.childLog().filter((entry) => entry.method === method)
      assert.equal(heard.length, 1, method)
      assert.match(heard[0].params.threadId, /^openai-thread-/)
    }
  } finally {
    await app.stop()
  }
})

// The child's thread/read carries its readState, from which the App marks the
// chat read or unread. A -32601 here would turn server read state off for
// the whole connection.
test("a native chat's read state is its child's, conflicts included", async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', { model: 'gpt-6.1-sol', cwd: app.home })
    const threadId = started.result.thread.id as string
    await runTurn(app, threadId, 'decline')
    const update = (expectedRevision: string) =>
      app.request('thread/readState/update', {
        threadId,
        operation: { type: 'unread' },
        expectedRevision,
      })

    const updated = await update('r1')
    assert.equal(updated.error, undefined, JSON.stringify(updated.error))
    assert.deepEqual(updated.result, {
      readState: { firstUnread: { type: 'threadStart' }, revision: 'r2' },
    })
    const heard = app.childLog().filter((entry) => entry.method === 'thread/readState/update')
    assert.equal(heard.length, 1)
    assert.match(heard[0].params.threadId, /^openai-thread-/)

    // The App reads the conflict's code and data.
    const stale = await update('r0')
    assert.equal(stale.error.code, -32600)
    assert.equal(stale.error.message, 'read state changed')
    assert.deepEqual(stale.error.data, {
      reason: 'readStateConflict',
      readState: { firstUnread: null, revision: 'r1' },
    })
  } finally {
    await app.stop()
  }
})

test('a chat keeps its harness once it has a conversation; a new one can still move', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', {
      model: 'codex-ag:claude-opus-5-5',
      cwd: app.home,
    })
    const threadId = started.result.thread.id as string
    await runTurn(app, threadId, 'accept')
    const toGpt = await app.request('thread/settings/update', { threadId, model: 'gpt-6.1-sol' })
    assert.equal(toGpt.error?.code, -32600)
    const toClaude = await app.request('thread/settings/update', {
      threadId,
      model: 'sonnet',
    })
    assert.equal(toClaude.error?.code, -32600)

    // A new chat's thread exists before its first message: the first turn's
    // model picks its harness.
    const fresh = await app.request('thread/start', { model: 'sonnet', cwd: app.home })
    const freshId = fresh.result.thread.id as string
    const { seen } = await runTurn(app, freshId, 'accept', { model: 'gpt-6.1-sol' })
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.threadId, freshId)
    assert.equal(delta.params.delta, 'openai:gpt-6.1-sol:accept')
  } finally {
    await app.stop()
  }
})

async function startChat(app: ReturnType<typeof startAdapter>, model = 'codex-ag:claude-opus-5-5') {
  await initialize(app)
  const answer = await app.request('thread/start', { model, cwd: app.home })
  assert.equal(answer.error, undefined)
  return answer.result.thread.id as string
}

test('opening a second adapter keeps live native sidebar activity and recovers a crashed owner', async () => {
  const first = startAdapter()
  const observers: Array<ReturnType<typeof startAdapter>> = []
  const openObserver = async () => {
    const observer = startAdapter({ home: first.home })
    observers.push(observer)
    await initialize(observer)
    return observer
  }
  try {
    const threadId = await startChat(first)
    const status = async (app: typeof first) => {
      const list = await app.request('thread/list', {})
      return list.result.data.find((thread: any) => thread.id === threadId)?.status
    }
    const startHeld = async () => {
      const started = await first.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'held' }],
      })
      assert.equal(started.error, undefined)
      return await first.reader.until((message) => message.method?.endsWith('requestApproval'))
    }
    const approval = await startHeld()
    const active = { type: 'active', activeFlags: ['waitingOnApproval'] }
    assert.deepEqual(await status(first), active)
    const second = await openObserver()
    assert.deepEqual(await status(second), active)
    assert.deepEqual(await status(first), active)
    first.proc.stdin.write(
      `${JSON.stringify({ id: approval.id, result: { decision: 'decline' } })}\n`,
    )
    await first.reader.until((message) => message.method === 'turn/completed')
    assert.deepEqual(await status(second), { type: 'idle' })
    await startHeld()
    assert.deepEqual(await status(second), active)
    const exited = once(first.proc, 'exit')
    first.proc.kill('SIGKILL')
    await exited
    const third = await openObserver()
    assert.deepEqual(await status(third), { type: 'idle' })
    assert.deepEqual(await status(second), { type: 'idle' })
  } finally {
    await first.stop()
    await Promise.all(observers.map((app) => app.stop()))
  }
})

test('a native chat resumes on its original provider and adapter id after a restart', async () => {
  const first = startAdapter({ env: { CLAUDE_CODEX_CODEX_AG_PROVIDER: 'fixture_a' } })
  const threadId = await startChat(first)
  try {
    await runTurn(first, threadId, 'accept')
  } finally {
    await first.stop()
  }
  const app = startAdapter({
    home: first.home,
    env: { CLAUDE_CODEX_CODEX_AG_PROVIDER: 'fixture_b' },
  })
  try {
    await initialize(app)
    const resumed = await app.request('thread/resume', { threadId, modelProvider: 'claude-code' })
    assert.equal(resumed.result.thread.id, threadId)
    assert.deepEqual(resumed.result.thread.turns, [{ id: 'turn-old' }])
    const { approval, seen } = await runTurn(app, threadId, 'decline')
    assert.equal(approval.params.threadId, threadId)
    assert.equal(
      seen.find((message) => message.method === 'item/agentMessage/delta').params.threadId,
      threadId,
    )
    const restore = app.childLog().find((entry) => entry.method === 'thread/resume')
    assert.equal(restore.provider, 'fixture_a')
    assert.equal(restore.params.modelProvider, 'fixture_a')
    assert.equal(restore.params.model, 'claude-opus-5-5')
    assert.equal(resumed.result.model, 'codex-ag:claude-opus-5-5')
    assert.match(
      seen.find((message) => message.method === 'item/agentMessage/delta').params.delta,
      /fixture_a:claude-opus-5-5:/,
    )
  } finally {
    await app.stop()
  }
  const disabled = startAdapter({ home: first.home, env: { CLAUDE_CODEX_NATIVE_CODEX: 'off' } })
  try {
    await initialize(disabled)
    assert.match(
      (await disabled.request('thread/resume', { threadId })).error.message,
      /enable CLAUDE_CODEX_NATIVE_CODEX/,
    )
    assert.ok(
      (await disabled.request('thread/list', {})).result.data.some(
        (row: any) => row.id === threadId,
      ),
    )
    const move = await disabled.request('thread/metadata/update', {
      threadId,
      model: 'gpt-6.1-sol',
    })
    assert.equal(move.error?.code, -32600)
    assert.deepEqual(disabled.childLog(), [])
  } finally {
    await disabled.stop()
  }
})

test('persisted exec-proxy conversations keep their route when native mode is enabled', async () => {
  const first = startAdapter()
  const threadId = await startChat(first, 'gpt-6.1-sol')
  try {
    await runTurn(first, threadId, 'accept')
  } finally {
    await first.stop()
  }
  // A database created before native mode has an exec session id and no provider binding.
  const db = new DatabaseSync(join(first.home, 'adapter', 'state.sqlite'))
  try {
    db.prepare('UPDATE threads SET native_codex_provider = NULL WHERE id = ?').run(threadId)
  } finally {
    db.close()
  }
  const app = startAdapter({ home: first.home })
  try {
    await initialize(app)
    const resumed = await app.request('thread/resume', { threadId })
    assert.equal(resumed.result.thread.id, threadId)
    assert.deepEqual(app.childLog(), [])
  } finally {
    await app.stop()
  }
})

test('native forks keep their provider in both directions, including description forks', async () => {
  const app = startAdapter()
  try {
    for (const [model, other] of [
      ['gpt-6.1-sol', 'codex-ag:claude-opus-5-5'],
      ['codex-ag:claude-opus-5-5', 'gpt-6.1-sol'],
    ] as const) {
      const threadId = await startChat(app, model)
      await runTurn(app, threadId, 'accept')
      const refused = await app.request('thread/fork', { threadId, model: other })
      assert.equal(refused.error.code, -32600)
      const fork = await app.request('thread/fork', { threadId, model })
      assert.equal(fork.result.model, model)
      assert.equal(fork.result.thread.forkedFromId, threadId)
      const forkResume = await app.request('thread/resume', { threadId: fork.result.thread.id })
      assert.equal(forkResume.result.model, model)
      const helper = await app.request('thread/fork', {
        threadId,
        model: 'gpt-summary',
        ephemeral: true,
        threadSource: 'thread_description',
      })
      assert.equal(helper.result.model, model)
    }
    assert.equal(app.childLog().filter((entry) => entry.method === 'thread/fork').length, 4)
  } finally {
    await app.stop()
  }
})

test('rejected archive or delete leaves the local record available', async () => {
  const app = startAdapter({ env: { FAKE_REFUSE_CHANGES: '1' } })
  try {
    const threadId = await startChat(app)
    await runTurn(app, threadId, 'decline')
    for (const method of ['thread/archive', 'thread/delete']) {
      assert.match((await app.request(method, { threadId })).error.message, /rollout unavailable/)
      const list = await app.request('thread/list', { archived: false })
      assert.ok(list.result.data.some((row: any) => row.id === threadId))
    }
  } finally {
    await app.stop()
  }
})

test('archive stops an active native turn, withdraws its approval, and unarchive restores history', async () => {
  const app = startAdapter()
  try {
    const threadId = await startChat(app)
    await app.request('turn/start', { threadId, input: [{ type: 'text', text: 'hello' }] })
    const approval = await app.reader.until((message) =>
      message.method?.endsWith('requestApproval'),
    )
    assert.equal((await app.request('thread/archive', { threadId })).error, undefined)
    assert.ok(
      app.reader.received.some(
        (message) =>
          message.method === 'serverRequest/resolved' && message.params.requestId === approval.id,
      ),
    )
    const log = app.childLog().map((entry) => entry.method)
    assert.ok(
      log.indexOf('turn/interrupt') >= 0 &&
        log.indexOf('turn/interrupt') < log.indexOf('thread/archive'),
    )
    assert.ok(
      (await app.request('thread/list', { archived: true })).result.data.some(
        (row: any) => row.id === threadId,
      ),
    )
    const restored = await app.request('thread/unarchive', { threadId })
    assert.equal(restored.result.thread.id, threadId)
    assert.deepEqual(restored.result.thread.turns, [{ id: 'turn-old' }])
  } finally {
    await app.stop()
  }
})

test('the child receives App config and enabled dynamic tools, with its provider pinned last', async () => {
  const app = startAdapter({
    args: ['-c', 'native_probe=true', '--config', 'model_provider="other"'],
    env: { CLAUDE_CODEX_DYNAMIC_TOOLS: '1' },
  })
  try {
    await initialize(app)
    const tools = [
      {
        type: 'namespace',
        name: 'sample',
        description: 'fixture',
        tools: [
          {
            type: 'function',
            name: 'about',
            description: 'fixture',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ]
    const start = await app.request('thread/start', {
      model: 'gpt-6.1-sol',
      cwd: app.home,
      permissions: ':read-only',
      dynamicTools: tools,
    })
    await runTurn(app, start.result.thread.id, 'decline')
    const spawn = app.childLog().find((entry) => entry.event === 'spawn')
    assert.deepEqual(spawn.argv.slice(0, 6), [
      '-c',
      'native_probe=true',
      '-c',
      'model_provider="other"',
      '-c',
      'model_provider="openai"',
    ])
    const params = app.childLog().find((entry) => entry.method === 'thread/start').params
    assert.equal(params.permissions, ':read-only')
    assert.equal(params.sandbox, undefined)
    assert.equal(params.dynamicTools[0].tools[0].name, 'about')
  } finally {
    await app.stop()
  }
})

test('native menus split a mixed default catalog and exclude the internal reviewer', async () => {
  const app = startAdapter({
    env: { CLAUDE_CODEX_CODEX_MODELS: '', CLAUDE_CODEX_CODEX_AG_MODELS: '' },
  })
  try {
    writeFileSync(
      join(app.home, 'model_catalog.json'),
      JSON.stringify({
        models: ['gpt-fixture', 'claude-fixture', 'codex-auto-review'].map((slug) => ({ slug })),
      }),
    )
    await initialize(app)
    const ids = (await app.request('model/list', {})).result.data.map((entry: any) => entry.id)
    assert.ok(ids.includes('gpt-fixture') && ids.includes('codex-ag:claude-fixture'))
    assert.ok(
      !ids.includes('claude-fixture') &&
        !ids.includes('codex-auto-review') &&
        !ids.includes('codex-ag:codex-auto-review'),
    )
  } finally {
    await app.stop()
  }
})

test('a single child write with a reply and a completed turn keeps wire order and allows idle stop', async () => {
  const app = startAdapter({
    env: { FAKE_IMMEDIATE_COMPLETION: '1', CLAUDE_CODEX_NATIVE_IDLE_MS: '75' },
  })
  try {
    const threadId = await startChat(app)
    const reply = await app.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hello' }],
    })
    await app.reader.until((message) => message.method === 'turn/completed')
    const trace = app.reader.received
    assert.ok(
      trace.indexOf(reply) < trace.findIndex((message) => message.method === 'turn/started'),
    )
    assert.deepEqual(
      trace
        .filter((message) => message.method === 'thread/started')
        .map((message) => message.params.thread.id),
      [threadId],
    )
    const end = Date.now() + 5000
    while (!app.childLog().some((entry) => entry.event === 'exit') && Date.now() < end)
      await delay(25)
    assert.ok(app.childLog().some((entry) => entry.event === 'exit'))
  } finally {
    await app.stop()
  }
})

test('a native user shell can begin the conversation with the configured adapter policy', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', {
      model: 'gpt-6.1-sol',
      cwd: app.home,
      permissions: 'custom-profile',
    })
    const threadId = started.result.thread.id
    assert.deepEqual(
      (await app.request('thread/shellCommand', { threadId, command: 'printf fixture' })).result,
      {},
    )
    await runTurn(app, threadId, 'decline')
    const initial = app.childLog().filter((entry) => entry.method === 'thread/start')
    assert.equal(initial.length, 1)
    assert.equal(initial[0].params.approvalPolicy, 'on-request')
    assert.equal(initial[0].params.sandbox, 'workspace-write')
    assert.ok(!('permissions' in initial[0].params))
    await app.request('thread/resume', { threadId, permissions: 'custom-profile' })
    assert.ok(
      !('permissions' in app.childLog().find((entry) => entry.method === 'thread/resume').params),
    )
    const shell = app.childLog().find((entry) => entry.method === 'thread/shellCommand')
    assert.equal(
      shell.params.threadId,
      app.childLog().find((entry) => entry.method === 'turn/start').params.threadId,
    )
  } finally {
    await app.stop()
  }
})

test('adapter shutdown waits for a native child that ignores SIGTERM', async () => {
  const app = startAdapter({ env: { FAKE_IGNORE_TERM: '1' } })
  let pid: number
  try {
    const threadId = await startChat(app)
    await runTurn(app, threadId, 'decline')
    pid = app.childLog().find((entry) => entry.event === 'spawn').pid
    assert.ok(Number.isInteger(pid))
  } finally {
    await app.stop()
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('a resume ignores a model on another backend or provider, as without native mode', async () => {
  const picks = [
    { model: 'gpt-6.1-sol' },
    { collaborationMode: { mode: 'default', settings: { model: 'gpt-6.1-sol' } } },
  ]
  for (const native of ['on', 'off']) {
    const app = startAdapter({ env: { CLAUDE_CODEX_NATIVE_CODEX: native } })
    try {
      const threadId = await startChat(app, 'sonnet')
      await app.request('turn/start', { threadId, input: [{ type: 'text', text: 'hello' }] })
      await app.reader.until((message) => message.method === 'turn/completed')
      for (const pick of picks) {
        const resumed = await app.request('thread/resume', { threadId, ...pick })
        assert.equal(resumed.error, undefined, `${native}: ${JSON.stringify(resumed.error)}`)
        assert.equal(resumed.result.model, 'sonnet')
      }
      assert.deepEqual(app.childLog(), [])
    } finally {
      await app.stop()
    }
  }
  const app = startAdapter()
  try {
    const threadId = await startChat(app)
    await runTurn(app, threadId, 'accept')
    for (const pick of picks) {
      const resumed = await app.request('thread/resume', { threadId, ...pick })
      assert.equal(resumed.error, undefined, JSON.stringify(resumed.error))
      assert.equal(resumed.result.model, 'codex-ag:claude-opus-5-5')
    }
    // The child hears the chat's own model, in the mode's settings too.
    assert.deepEqual(
      app
        .childLog()
        .filter((entry) => entry.method === 'thread/resume')
        .map((entry) => [entry.params.model, entry.params.collaborationMode?.settings.model]),
      [
        ['claude-opus-5-5', undefined],
        ['claude-opus-5-5', 'claude-opus-5-5'],
      ],
    )
    const { seen } = await runTurn(app, threadId, 'accept')
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.delta, 'astergate_claude:claude-opus-5-5:accept')
  } finally {
    await app.stop()
  }
})

test('a second adapter refuses to run or rewrite a native chat while another one’s turn is live', async () => {
  const first = startAdapter()
  const apps = [first]
  try {
    const threadId = await startChat(first)
    await runTurn(first, threadId, 'accept')
    const hold = async (app: typeof first) => {
      const started = await app.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'held' }],
      })
      assert.equal(started.error, undefined, JSON.stringify(started.error))
      const approval = await app.reader.until((message) =>
        message.method?.endsWith('requestApproval'),
      )
      return { turnId: started.result.turn.id as string, approval }
    }
    const held = await hold(first)
    const second = startAdapter({ home: first.home, log: join(first.home, 'second.log') })
    apps.push(second)
    await initialize(second)
    const refused = [
      ['turn/start', { threadId, input: [{ type: 'text', text: 'second' }] }],
      ['thread/shellCommand', { threadId, command: 'ls' }],
      ['review/start', { threadId, target: { type: 'uncommittedChanges' } }],
      ['thread/compact/start', { threadId }],
      ['thread/rollback', { threadId, numTurns: 1 }],
      ['thread/inject_items', { threadId, items: [] }],
      ['thread/goal/set', { threadId, objective: 'fixture' }],
      ['turn/steer', { threadId, expectedTurnId: held.turnId, input: [] }],
      ['turn/interrupt', { threadId, turnId: held.turnId }],
      ['thread/archive', { threadId }],
      ['thread/delete', { threadId }],
    ] as const
    for (const [method, params] of refused) {
      const answer = await second.request(method, params)
      assert.equal(answer.error?.code, -32600, method)
      assert.match(answer.error.message, /active turn in another adapter process/, method)
    }
    // No second child started, and the running turn goes on.
    assert.deepEqual(second.childLog(), [])
    first.proc.stdin.write(
      `${JSON.stringify({ id: held.approval.id, result: { decision: 'accept' } })}\n`,
    )
    await first.reader.until((message) => message.method === 'turn/completed')

    // Once it ends, either adapter runs the next turn, one at a time.
    await hold(second)
    const blocked = await first.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'first' }],
    })
    assert.match(blocked.error?.message ?? '', /active turn in another adapter process/)
    // An adapter that exited leaves the chat to the next one, idle even
    // when what comes next is no turn.
    const exited = once(second.proc, 'exit')
    second.proc.kill('SIGKILL')
    await exited
    assert.deepEqual((await first.request('thread/rollback', { threadId, numTurns: 1 })).result, {})
    const listed = await first.request('thread/list', {})
    assert.deepEqual(listed.result.data.find((row: any) => row.id === threadId).status, {
      type: 'idle',
    })
    await runTurn(first, threadId, 'decline')
  } finally {
    await Promise.all(apps.map((app) => app.stop()))
  }
})

// The adapter that holds a native chat's claim, as the state database says.
function nativeOwner(home: string, threadId: string): number | null {
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { timeout: 5000 })
  try {
    const row = db
      .prepare('SELECT native_active_owner_pid AS pid FROM threads WHERE id = ?')
      .get(threadId) as { pid: number | null } | undefined
    return row?.pid ?? null
  } finally {
    db.close()
  }
}

// Polls with a deadline far beyond what a loaded machine needs.
async function eventually(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 60_000
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what} never happened`)
    await delay(50)
  }
}

// The fake child answers a shell command, review or compaction and never
// announces its turn.
const UNANNOUNCED = (threadId: string) =>
  [
    ['thread/shellCommand', { threadId, command: 'ls' }],
    ['review/start', { threadId, target: { type: 'uncommittedChanges' } }],
    ['thread/compact/start', { threadId }],
  ] as const

test('a native claim ends with its request, or a while after a turn Codex never announced', async () => {
  // The wait is far longer than a request and the check after it take on a
  // loaded machine, so each claim is still held when it is checked.
  const app = startAdapter({
    env: { CLAUDE_CODEX_NATIVE_TURN_WAIT_MS: '5000', FAKE_REFUSE_CHANGES: '1' },
  })
  try {
    const chat = async () => {
      const id = await startChat(app)
      await runTurn(app, id, 'accept')
      return id
    }
    const threadId = await chat()
    const owner = (id = threadId) => nativeOwner(app.home, id)
    assert.equal(owner(), null)
    // A rollback, or a request Codex refuses, holds it while it runs.
    assert.deepEqual((await app.request('thread/rollback', { threadId, numTurns: 1 })).result, {})
    assert.equal(owner(), null)
    assert.match((await app.request('thread/archive', { threadId })).error.message, /unavailable/)
    assert.equal(owner(), null)
    // Each on a chat of its own, so no claim stands in for another.
    const chats = [threadId, await chat(), await chat()]
    const requests = chats.flatMap((id, i) => UNANNOUNCED(id).slice(i, i + 1))
    for (const [method, params] of requests) {
      assert.equal((await app.request(method, params)).error, undefined, method)
      assert.equal(owner(params.threadId), app.proc.pid, method)
    }
    for (const [method, params] of requests)
      await eventually(() => owner(params.threadId) === null, `${method} claim release`)
    // A request that ends meanwhile leaves the claim to the one still waiting.
    const overlapping = [
      { id: 9001, method: 'thread/compact/start', params: { threadId } },
      { id: 9002, method: 'thread/rollback', params: { threadId, numTurns: 1 } },
    ]
    app.proc.stdin.write(overlapping.map((message) => `${JSON.stringify(message)}\n`).join(''))
    for (const { id } of overlapping) {
      const answer = await app.reader.until((message) => message.id === id && !message.method)
      assert.equal(answer.error, undefined)
    }
    assert.equal(owner(), app.proc.pid)
    await eventually(() => owner() === null, 'compaction claim release')
  } finally {
    await app.stop()
  }
})

test('a native claim for a turn Codex never announced ends with its child or adapter', async () => {
  const app = startAdapter()
  try {
    const threadId = await startChat(app)
    await runTurn(app, threadId, 'accept')
    const owner = () => nativeOwner(app.home, threadId)
    for (const [method, params] of UNANNOUNCED(threadId)) {
      assert.equal((await app.request(method, params)).error, undefined, method)
      assert.equal(owner(), app.proc.pid, method)
      const child = app.childLog().findLast((entry) => entry.event === 'spawn').pid as number
      process.kill(child, 'SIGKILL')
      await eventually(() => owner() === null, `${method} claim release on exit`)
    }
    assert.equal((await app.request('thread/compact/start', { threadId })).error, undefined)
    assert.equal(owner(), app.proc.pid)
    await app.stop()
    assert.equal(owner(), null)
  } finally {
    await app.stop()
  }
})

test('a native claim for a turn Codex never announced ends when the idle child stops', async () => {
  // The idle stop comes far later than the probe right after the compaction
  // can take on a loaded machine; the second adapter is up before it starts.
  const first = startAdapter({ env: { CLAUDE_CODEX_NATIVE_IDLE_MS: '6000' } })
  const second = startAdapter({ home: first.home, log: join(first.home, 'second.log') })
  try {
    await initialize(second)
    const threadId = await startChat(first)
    await runTurn(first, threadId, 'accept')
    const exits = () => first.childLog().filter((entry) => entry.event === 'exit').length
    const before = exits()
    assert.equal((await first.request('thread/compact/start', { threadId })).error, undefined)
    const probe = () => second.request('thread/rollback', { threadId, numTurns: 1 })
    assert.match((await probe()).error?.message ?? '', /active turn in another adapter process/)
    await eventually(() => exits() > before, 'idle child stop')
    await eventually(() => nativeOwner(first.home, threadId) === null, 'claim release')
    assert.deepEqual((await probe()).result, {})
  } finally {
    await Promise.all([first.stop(), second.stop()])
  }
})

test('a turn Codex announces late is stopped and leaves another adapter’s claim alone', async () => {
  const first = startAdapter({
    env: { CLAUDE_CODEX_NATIVE_TURN_WAIT_MS: '500', FAKE_LATE_TURN: '1' },
  })
  const second = startAdapter({ home: first.home, log: join(first.home, 'second.log') })
  try {
    await initialize(second)
    const threadId = await startChat(first)
    await runTurn(first, threadId, 'accept')
    assert.equal((await first.request('thread/compact/start', { threadId })).error, undefined)
    await eventually(() => nativeOwner(first.home, threadId) === null, 'claim release')
    const started = await second.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'held' }],
    })
    assert.equal(started.error, undefined, JSON.stringify(started.error))
    await second.reader.until((message) => message.method?.endsWith('requestApproval'))
    // The first child now announces the compaction's turn; the first adapter
    // stops it.
    assert.equal((await first.request('thread/goal/get', { threadId })).error, undefined)
    const ended = await first.reader.until(
      (message) => message.method === 'turn/completed' && message.params.turn.id === 'turn-late',
    )
    assert.equal(ended.params.turn.status, 'interrupted')
    assert.ok(
      first
        .childLog()
        .some((entry) => entry.method === 'turn/interrupt' && entry.params.turnId === 'turn-late'),
    )
    assert.equal(nativeOwner(first.home, threadId), second.proc.pid)
    const listed = await second.request('thread/list', {})
    assert.deepEqual(listed.result.data.find((row: any) => row.id === threadId).status, {
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    })
  } finally {
    await Promise.all([first.stop(), second.stop()])
  }
})

test('with native mode on, a chat on the exec route and a fork made here refuse Codex+AsterGate models', async () => {
  const first = startAdapter()
  const threadId = await startChat(first, 'gpt-6.1-sol')
  try {
    await runTurn(first, threadId, 'accept')
  } finally {
    await first.stop()
  }
  // A conversation from `codex exec`, as in a database from before native mode.
  const db = new DatabaseSync(join(first.home, 'adapter', 'state.sqlite'))
  try {
    db.prepare('UPDATE threads SET native_codex_provider = NULL WHERE id = ?').run(threadId)
  } finally {
    db.close()
  }
  const ag = 'codex-ag:claude-opus-5-5'
  for (const native of ['on', 'off']) {
    const app = startAdapter({ home: first.home, env: { CLAUDE_CODEX_NATIVE_CODEX: native } })
    try {
      await initialize(app)
      for (const method of ['thread/settings/update', 'thread/metadata/update']) {
        const answer = await app.request(method, { threadId, model: ag })
        // Without native mode the id is not a model, and the chat keeps its own.
        if (native === 'off') assert.doesNotMatch(answer.error?.message ?? '', /AsterGate/)
        else {
          assert.equal(answer.error?.code, -32600, method)
          assert.match(answer.error.message, /from Codex to Codex\+AsterGate/, method)
        }
      }
      if (native === 'on') {
        const turn = await app.request('turn/start', {
          threadId,
          model: ag,
          input: [{ type: 'text', text: 'hello' }],
        })
        assert.equal(turn.error?.code, -32600)
        const claude = await app.request('thread/start', { model: 'sonnet', cwd: app.home })
        for (const parent of [threadId, claude.result.thread.id]) {
          const fork = await app.request('thread/fork', { threadId: parent, model: ag })
          assert.match(fork.error?.message ?? '', /cannot run on Codex\+AsterGate/)
        }
      }
      const resumed = await app.request('thread/resume', { threadId, model: ag })
      assert.equal(resumed.result.model, 'gpt-6.1-sol')
      assert.deepEqual(app.childLog(), [])
    } finally {
      await app.stop()
    }
  }
})
