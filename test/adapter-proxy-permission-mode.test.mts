import './support/hermetic-env.mjs'
import assert from 'node:assert/strict'
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import test from 'node:test'
import WebSocket from 'ws'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'
import { adapter, stopProcess, textInput } from './support/adapter-harness.mjs'
import {
  type NativeClaudeEvent,
  nativeClaudeTestEnv,
  readNativeClaudeEvents,
} from './support/native-claude-fixture.mjs'

const socket = (): string =>
  join(tmpdir(), `ccx-proxy-${Math.random().toString(36).slice(2, 10)}.sock`)

function stderrText(proc: ChildProcess): () => string {
  let text = ''
  const stderr = proc.stderr
  if (stderr) {
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      text += chunk
    })
  }
  return () => text
}

class WebSocketJsonReader {
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  next(): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async nextResponse(id: number): Promise<any> {
    for (;;) {
      const message = await this.next()
      if (message.id === id && message.method == null) return message
    }
  }
}

class ChildProcessDuplex extends Duplex {
  private readonly proc: ChildProcess

  constructor(proc: ChildProcess) {
    super()
    this.proc = proc
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.proc.stdin?.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.proc.stdin?.end()
    callback()
  }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForLaunches(log: string, count: number): Promise<NativeClaudeEvent[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const events = await readNativeClaudeEvents(log)
    if (events.filter((event) => event.event === 'spawn').length >= count) return events
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${count} native Claude launches`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function startDaemon(sock: string, home: string, fixtureEnv: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PATH: process.env.PATH,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      ...fixtureEnv,
    },
  })
}

function startProxy(sock: string, fixtureEnv: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: process.env.PATH,
      ...fixtureEnv,
    },
  }) as ChildProcessWithoutNullStreams
}

async function turn(
  ws: WebSocket,
  reader: WebSocketJsonReader,
  id: number,
  threadId: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  ws.send(
    JSON.stringify({
      id,
      method: 'turn/start',
      params: { threadId, input: textInput(`native proxy permission turn ${id}`), ...params },
    }),
  )
  let turnId: string | null = null
  let completed = false
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const message = await reader.next()
    if (message.id === id && message.method == null) {
      if (message.error) throw new Error(JSON.stringify(message.error))
      turnId = message.result?.turn?.id ?? null
    }
    if (
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId &&
      (turnId === null || message.params?.turn?.id === turnId)
    ) {
      assert.equal(message.params.turn.status, 'completed')
      completed = true
    }
    if (turnId !== null && completed) return
  }
  throw new Error(`turn ${id} did not complete`)
}

function launchModes(events: NativeClaudeEvent[]): string[] {
  return events
    .filter((event) => event.event === 'spawn')
    .map((event) => {
      assert.equal(typeof event.permissionMode, 'string')
      assert.ok(Array.isArray(event.argv))
      assert.ok(event.argv.includes(`--permission-mode=${event.permissionMode}`))
      if (event.permissionMode === 'bypassPermissions')
        assert.ok(event.argv.includes('--allow-dangerously-skip-permissions'))
      else assert.ok(!event.argv.includes('--allow-dangerously-skip-permissions'))
      return event.permissionMode as string
    })
}

test('app-server proxy carries native permission modes through a Unix daemon', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-proxy-'))
  const sock = socket()
  const fixture = await nativeClaudeTestEnv(home)
  const daemon = startDaemon(sock, home, fixture.env)
  let proxy: ChildProcessWithoutNullStreams | null = null
  let ws: WebSocket | null = null
  const daemonStderr = stderrText(daemon)
  try {
    await waitFor(() => /listening on/.test(daemonStderr()), 'Unix daemon readiness')
    proxy = startProxy(sock, fixture.env)
    const proxyStderr = stderrText(proxy)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')

    ws.send(
      JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'native-permission-test', version: '1' },
          capabilities: null,
        },
      }),
    )
    const initialized = await reader.nextResponse(1)
    assert.equal(typeof initialized.result.userAgent, 'string')
    assert.equal(typeof initialized.result.codexHome, 'string')

    ws.send(
      JSON.stringify({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), permissions: ':danger-full-access' },
      }),
    )
    const started = await reader.nextResponse(2)
    const threadId = started.result.thread.id as string
    assert.equal(started.result.activePermissionProfile.id, ':danger-full-access')
    assert.equal(started.result.approvalPolicy, 'never')
    assert.equal(started.result.sandbox.type, 'dangerFullAccess')

    // The first turn names no permission fields: it inherits Full Access from
    // thread/start and must launch the real native SDK CLI in bypass mode.
    if (!ws) throw new Error('proxy websocket did not start')
    await turn(ws, reader, 3, threadId)
    let events = await waitForLaunches(fixture.log, 1)
    assert.deepEqual(launchModes(events), ['bypassPermissions'])

    // A second fieldless turn is a separate native launch, and must inherit the
    // same Full Access mode rather than falling back to the SDK default.
    await turn(ws, reader, 4, threadId)
    events = await waitForLaunches(fixture.log, 2)
    assert.deepEqual(launchModes(events), ['bypassPermissions', 'bypassPermissions'])

    // An unknown profile by itself must revoke the prior Full Access policy;
    // it must never leave the native process in bypassPermissions.
    await turn(ws, reader, 5, threadId, { permissions: 'unknown-test-profile' })
    events = await waitForLaunches(fixture.log, 3)
    assert.deepEqual(launchModes(events), ['bypassPermissions', 'bypassPermissions', 'default'])

    // The built-in restricted profiles remain restricted after the unknown
    // profile transition, including the read-only profile.
    await turn(ws, reader, 6, threadId, { permissions: ':workspace' })
    await turn(ws, reader, 7, threadId, { permissions: ':read-only' })
    events = await waitForLaunches(fixture.log, 5)
    assert.deepEqual(launchModes(events), [
      'bypassPermissions',
      'bypassPermissions',
      'default',
      'default',
      'default',
    ])

    // The proxy itself must remain a transparent stdio process: a native CLI
    // launch failure would otherwise be easy to mistake for a protocol reply.
    assert.equal(proxyStderr(), '')
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.on('error', () => {})
      ws.terminate()
    }
    if (proxy) await stopProcess(proxy)
    await stopProcess(daemon)
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('active turns guard live permission changes while allowing one-turn Plan follow-ups and reconnects', async () => {
  let releaseTurn: () => void = () => {}
  let startedTurn: () => void = () => {}
  const steered: string[] = []
  const runtime = scriptedRuntime(
    async (_context, handlers) => {
      startedTurn()
      await new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    {
      steer: async (_threadId, prompt) => {
        steered.push(prompt)
        return true
      },
    },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread({
      cwd: app.home,
      permissions: ':danger-full-access',
    })

    // Start a Full Access turn and hold it open.
    const running = new Promise<void>((resolve) => {
      startedTurn = resolve
    })
    const firstTurnId = await app.startTurn(threadId, 'first full access turn')
    await running

    // Settings and metadata updates refuse permission boundary changes mid-turn,
    // while non-permission updates still succeed.
    const settingsRefused = await app.call('thread/settings/update', {
      threadId,
      permissions: ':read-only',
    })
    assert.match(settingsRefused.error?.message ?? '', /cannot change permission mode/)
    const metadataRefused = await app.call('thread/metadata/update', {
      threadId,
      sandbox: 'read-only',
    })
    assert.match(metadataRefused.error?.message ?? '', /cannot change permission mode/)
    const effortAllowed = await app.call('thread/settings/update', {
      threadId,
      effort: 'high',
    })
    assert.equal(effortAllowed.error, undefined)

    // Reconnecting via thread/resume during a running turn must not fail or
    // mutate the active turn's permission boundary.
    const resumed = await app.request('thread/resume', {
      threadId,
      sandbox: 'read-only',
    })
    assert.equal(resumed.approvalPolicy, 'never')
    assert.equal(resumed.sandbox.type, 'dangerFullAccess')

    // A turn/start changing permission mode while running is refused.
    const turnRefused = await app.call('turn/start', {
      threadId,
      input: textInput('switch to read only'),
      permissions: ':read-only',
    })
    assert.match(turnRefused.error?.message ?? '', /cannot change permission mode/)

    releaseTurn()
    await app.turnCompleted(firstTurnId)

    // A one-turn Plan run (legacy planMode: true, thread collaborationMode null)
    // must still accept an ordinary follow-up that omits planMode, while
    // rejecting an explicit planMode: false mid-turn.
    const planRunning = new Promise<void>((resolve) => {
      startedTurn = resolve
    })
    const planTurnId = await app.startTurn(threadId, 'plan something', { planMode: true })
    await planRunning

    const followUp = await app.call('turn/start', {
      threadId,
      input: textInput('one more detail for the plan'),
    })
    assert.equal(followUp.error, undefined)
    assert.equal(followUp.result?.turn?.id, planTurnId)
    assert.deepEqual(steered, ['one more detail for the plan'])

    const exitPlanRefused = await app.call('turn/start', {
      threadId,
      input: textInput('drop plan mode mid-turn'),
      planMode: false,
    })
    assert.match(exitPlanRefused.error?.message ?? '', /cannot change permission mode/)

    releaseTurn()
    await app.turnCompleted(planTurnId)
  })
})
