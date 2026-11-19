import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { HttpAgentRuntime } from '../src/http-agent-runtime.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

// An agent-http bridge that records every POST /message and holds the first one
// until the test releases it, so a steer can arrive while the turn is starting.
async function startBridge() {
  const posts: string[] = []
  let releaseFirst!: () => void
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let firstArrived!: () => void
  const firstSeen = new Promise<void>((resolve) => {
    firstArrived = resolve
  })
  let stable = false
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/messages') return json({ messages: [] })
    if (req.method === 'GET' && req.url === '/status') {
      return json({ status: stable ? 'stable' : 'running' })
    }
    if (req.method === 'POST' && req.url === '/message') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { content } = JSON.parse(body) as { content: string }
      const first = posts.length === 0
      posts.push(content)
      if (first) {
        firstArrived()
        await firstReleased
      }
      return json({ ok: true })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    posts,
    firstSeen,
    releaseFirst,
    finish: () => {
      stable = true
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function turnContext(threadId: string, prompt: string): RuntimeTurnContext {
  return {
    threadId,
    turnId: 'turn-1',
    prompt,
    cwd: process.cwd(),
    runtimeType: null,
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    imageInputs: [],
  } as unknown as RuntimeTurnContext
}

function handlers(events: RuntimeEvent[]): RuntimeHandlers {
  return {
    onEvent: (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ behavior: 'deny', message: 'test' }) as never,
  } as RuntimeHandlers
}

test('http runtime steers a turn only after its own prompt is posted', {
  timeout: 10_000,
}, async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 10_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: 'claude-codex-mode',
  })
  const events: RuntimeEvent[] = []
  try {
    assert.equal(await runtime.steer('unknown-thread', 'nobody runs me'), false)

    const turn = runtime.runTurn(turnContext('thread-1', 'the prompt'), handlers(events))
    await bridge.firstSeen
    assert.equal(await runtime.steer('thread-1', 'too early'), false)
    assert.deepEqual(bridge.posts, ['the prompt'])

    bridge.releaseFirst()
    let steered: boolean | undefined = false
    for (let i = 0; i < 200 && steered === false; i += 1) {
      steered = await runtime.steer('thread-1', 'in time')
      if (steered === false) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(steered, undefined)
    assert.equal(bridge.posts.length, 2)
    assert.equal(bridge.posts[0], 'the prompt')
    assert.match(bridge.posts[1] ?? '', /in time/)

    bridge.finish()
    await turn
    assert.ok(events.some((event) => event.type === 'completed' && event.success))
    assert.equal(await runtime.steer('thread-1', 'after the turn'), false)
    assert.equal(bridge.posts.length, 2)
  } finally {
    await runtime.stop()
    await bridge.close()
  }
})

test('interrupting a queued HTTP turn leaves the bridge owner running and skips the canceled prompt', {
  timeout: 10_000,
}, async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 5_000,
    sendInterruptRaw: true,
    manageBridge: false,
    modeCommand: '',
  })
  const canceled: RuntimeEvent[] = []
  const first = runtime.runTurn(turnContext('first', 'first prompt'), handlers([]))
  await bridge.firstSeen
  try {
    const queued = runtime.runTurn(turnContext('second', 'canceled prompt'), handlers(canceled))
    await runtime.interrupt('unknown')
    await runtime.interrupt('second')
    const next = runtime.runTurn(turnContext('third', 'third prompt'), handlers([]))
    assert.deepEqual(bridge.posts, ['first prompt'])
    await queued
    assert.ok(canceled.some((event) => event.type === 'completed' && !event.success))
    assert.deepEqual(bridge.posts, ['first prompt'])
    bridge.releaseFirst()
    bridge.finish()
    await Promise.all([first, next])
    assert.deepEqual(bridge.posts, ['first prompt', 'third prompt'])
  } finally {
    bridge.releaseFirst()
    bridge.finish()
    await runtime.stop()
    await first.catch(() => undefined)
    await bridge.close()
  }
})

test('the HTTP turn deadline cancels a bridge request that never returns', {
  timeout: 5_000,
}, async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agentapi',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 1_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: '',
  })
  const turn = runtime.runTurn(turnContext('one', 'no reply'), handlers([]))
  const rejected = assert.rejects(turn, /turn timed out after 1000ms/)
  try {
    await rejected
    assert.deepEqual(bridge.posts, ['no reply'])
  } finally {
    bridge.releaseFirst()
    bridge.finish()
    await runtime.stop()
    await bridge.close()
  }
})

test('stopping the HTTP runtime cancels the active and queued turns', {
  timeout: 10_000,
}, async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 5_000,
    sendInterruptRaw: true,
    manageBridge: false,
    modeCommand: '',
  })
  const firstEvents: RuntimeEvent[] = []
  const secondEvents: RuntimeEvent[] = []
  try {
    const first = runtime.runTurn(turnContext('one', 'running prompt'), handlers(firstEvents))
    await bridge.firstSeen
    const second = runtime.runTurn(turnContext('two', 'queued prompt'), handlers(secondEvents))
    await runtime.stop()
    await Promise.all([first, second])
    assert.deepEqual(bridge.posts, ['running prompt'])
    for (const events of [firstEvents, secondEvents])
      assert.ok(events.some((event) => event.type === 'completed' && !event.success))
  } finally {
    bridge.releaseFirst()
    bridge.finish()
    await runtime.stop()
    await bridge.close()
  }
})

test('an active bridge receives one raw interrupt before the next queued turn', {
  timeout: 10_000,
}, async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agentapi',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 5_000,
    sendInterruptRaw: true,
    manageBridge: false,
    modeCommand: '',
  })
  try {
    const first = runtime.runTurn(turnContext('one', 'first prompt'), handlers([]))
    await bridge.firstSeen
    const second = runtime.runTurn(turnContext('two', 'next prompt'), handlers([]))
    await Promise.all([runtime.interrupt('one'), runtime.interrupt('one')])
    bridge.releaseFirst()
    bridge.finish()
    await Promise.all([first, second])
    assert.deepEqual(bridge.posts, ['first prompt', '\u0003', 'next prompt'])
  } finally {
    bridge.releaseFirst()
    bridge.finish()
    await runtime.stop()
    await bridge.close()
  }
})
