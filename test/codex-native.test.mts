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

function startAdapter(options: { home?: string; env?: NodeJS.ProcessEnv; args?: string[] } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'codex-native-'))
  if (!options.home) dirs.push(home)
  const log = join(home, 'fake.log')
  const proc = spawn(
    process.execPath,
    [adapter, 'app-server', '--listen', 'stdio://', ...(options.args ?? [])],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        ...nativeCodexTestEnv(home),
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
