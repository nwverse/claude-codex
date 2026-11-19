import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import { nativeCodexTestEnv } from './support/native-codex-fixture.mjs'

// Several clients following one thread: two App windows on one chat, or the
// App and another app-server client on the same daemon.

const adapter = resolve('dist/src/adapter.mjs')

test('every follower of a thread gets its events; the others get the user message', {
  timeout: 20_000,
}, async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const b = await connect()
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })

    await a.request('turn/start', { threadId, input: textInput('hello from a') })
    const seenA = await a.until((message) => message.method === 'turn/completed')
    const seenB = await b.until((message) => message.method === 'turn/completed')

    for (const seen of [seenA, seenB]) {
      assert.ok(seen.some((message) => message.method === 'turn/started'))
      assert.match(agentText(seen), /hello from a/)
    }
    // A drew its own message; B did not send it, so it is told.
    assert.equal(userMessages(seenA).length, 0)
    assert.equal(userMessages(seenB).length, 2)
    assert.equal(userMessages(seenB)[0].params.item.content[0].text, 'hello from a')
  })
})

test('an approval goes to every follower; the first answer wins', { timeout: 20_000 }, async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const b = await connect()
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })

    await a.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const isApproval = (message: any) => message.method === 'item/commandExecution/requestApproval'
    const requestA = (await a.until(isApproval)).at(-1)
    const requestB = (await b.until(isApproval)).at(-1)
    assert.equal(requestA.id, requestB.id)

    b.respond(requestB.id, { decision: 'accept' })
    const resolvedB = (await b.until((message) => message.method === 'serverRequest/resolved')).at(
      -1,
    )
    assert.deepEqual(resolvedB.params, { threadId, requestId: requestA.id })
    // Too late: ignored.
    a.respond(requestA.id, { decision: 'decline' })

    const seenA = await a.until((message) => message.method === 'turn/completed')
    const resolvedA = seenA.find((message) => message.method === 'serverRequest/resolved')
    assert.deepEqual(resolvedA?.params, { threadId, requestId: requestA.id })
    const seenB = await b.until((message) => message.method === 'turn/completed')
    for (const seen of [seenA, seenB]) {
      assert.ok(
        seen.some(
          (message) =>
            message.method === 'item/commandExecution/outputDelta' &&
            /mock approval/.test(message.params.delta),
        ),
        'the accepted command ran',
      )
    }
  })
})

test('a pending approval reaches a peer that opens the thread later', {
  timeout: 20_000,
}, async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const threadId = await startThread(a)
    await a.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const request = (
      await a.until((message) => message.method === 'item/commandExecution/requestApproval')
    ).at(-1)

    const stranger = await connect()
    await stranger.request('thread/list', {})

    const late = await connect()
    await late.request('thread/resume', { threadId })
    const replayed = (
      await late.until((message) => message.method === 'item/commandExecution/requestApproval')
    ).at(-1)
    assert.equal(replayed.id, request.id)
    assert.equal(replayed.params.threadId, threadId)

    a.close()
    late.respond(replayed.id, { decision: 'accept' })
    const seen = await late.until((message) => message.method === 'turn/completed')
    assert.ok(seen.some((message) => message.method === 'serverRequest/resolved'))
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          /mock approval/.test(message.params.delta),
      ),
    )
    assert.equal(
      stranger.received.some((message) => message.method === 'turn/completed'),
      false,
      'a peer that never opened the thread hears nothing of it',
    )
  })
})

test('a turn/start racing thread/delete does not bring the thread back', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect) => {
    const a = connect('a')
    const b = connect('b')
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })
    await a.request('turn/start', { threadId, input: textInput('please run approval bash') })
    await b.until((message) => message.method === 'item/commandExecution/requestApproval')

    // The delete interrupts the running turn first; the turn/start arrives meanwhile.
    const [deleted, started] = await Promise.allSettled([
      a.request('thread/delete', { threadId }),
      b.request('turn/start', { threadId, input: textInput('hi') }),
    ])
    assert.equal(deleted.status, 'fulfilled')
    assert.equal(started.status, 'rejected')
    assert.match(String(started.reason), /unknown thread/)
    await b.until((message) => message.method === 'thread/deleted')

    const listed = await b.request('thread/list', {})
    assert.equal(
      listed.result.data.some((thread: any) => thread.id === threadId),
      false,
      'the deleted thread stays deleted',
    )
  })
})

test('a turn/start on a subagent thread of a chat being deleted is refused', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect) => {
    const a = connect('a')
    const b = connect('b')
    const threadId = await startThread(a)
    // thread/delete takes a chat's subagent threads with it.
    const fork = await b.request('thread/fork', { threadId, threadSource: 'subagent' })
    const childId = fork.result.thread.id
    await a.request('turn/start', { threadId, input: textInput('please run approval bash') })
    await a.until((message) => message.method === 'item/commandExecution/requestApproval')

    const [deleted, started] = await Promise.allSettled([
      a.request('thread/delete', { threadId }),
      b.request('turn/start', { threadId: childId, input: textInput('hi') }),
    ])
    assert.equal(deleted.status, 'fulfilled')
    assert.equal(started.status, 'rejected')
    assert.match(String(started.reason), /unknown thread/)
    await b.until(
      (message) => message.method === 'thread/deleted' && message.params.threadId === childId,
    )
  })
})

test('a turn/start keeps a rename that lands while it starts', { timeout: 20_000 }, async () => {
  await withServer(async (connect) => {
    const a = connect('a')
    const b = connect('b')
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })

    await Promise.all([
      a.request('turn/start', { threadId, input: textInput('hello') }),
      b.request('thread/name/set', { threadId, name: 'Renamed' }),
    ])
    await a.until((message) => message.method === 'turn/completed')

    const read = await b.request('thread/read', { threadId })
    assert.equal(read.result.thread.name, 'Renamed')
  })
})

test('an approval left by an interrupted turn is not shown to a later follower', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect, debugLog) => {
    const app = connect('app')
    const threadId = await startThread(app)
    await app.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const request = (
      await app.until((message) => message.method === 'item/commandExecution/requestApproval')
    ).at(-1)
    await app.request('turn/interrupt', { threadId })
    await app.until((message) => message.method === 'turn/completed')

    const late = connect('app-2')
    await late.request('thread/resume', { threadId })
    assert.equal(
      late.received.some((message) => message.method === 'item/commandExecution/requestApproval'),
      false,
      'the turn that asked has ended',
    )

    // The request ended with its turn: an answer now is ignored, and the idle
    // thread is not reported active again.
    const before = app.received.length
    await app.respond(request.id, { decision: 'accept' })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.deepEqual(ignoredResponses(debugLog), [['app', request.id, 'notPending']])
    assert.deepEqual(
      app.received.slice(before).map((message) => message.method),
      [],
      'nothing follows a late answer',
    )
  })
})

test('an interrupted turn takes its approval card down on every follower', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect) => {
    const a = connect('a')
    const b = connect('b')
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })
    await a.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const isApproval = (message: any) => message.method === 'item/commandExecution/requestApproval'
    const request = (await a.until(isApproval)).at(-1)
    await b.until(isApproval)

    await a.request('turn/interrupt', { threadId })
    for (const peer of [a, b]) {
      const resolved = (
        await peer.until((message) => message.method === 'serverRequest/resolved')
      ).at(-1)
      assert.deepEqual(resolved.params, { threadId, requestId: request.id })
    }
  })
})

test('a client that closes a thread and opens it again gets its pending approval again', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect) => {
    const app = connect('app')
    const threadId = await startThread(app)
    await app.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const isApproval = (message: any) => message.method === 'item/commandExecution/requestApproval'
    const request = (await app.until(isApproval)).at(-1)

    // Closing the chat takes its approval card down; opening it shows the card again.
    await app.request('thread/unsubscribe', { threadId })
    await app.until((message) => message.method === 'thread/closed')
    await app.request('thread/resume', { threadId })
    const replayed = (await app.until(isApproval)).at(-1)
    assert.equal(replayed.id, request.id)

    await app.respond(replayed.id, { decision: 'accept' })
    const seen = await app.until((message) => message.method === 'turn/completed')
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          /mock approval/.test(message.params.delta),
      ),
      'the accepted command ran',
    )
  })
})

test('any client may answer a pending approval; a later answer is ignored', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect, debugLog) => {
    const app = connect('app')
    const threadId = await startThread(app)
    await app.request('turn/start', { threadId, input: textInput('please run approval bash') })
    const request = (
      await app.until((message) => message.method === 'item/commandExecution/requestApproval')
    ).at(-1)

    // The App back from a reconnect, before it reopens the thread.
    const reconnected = connect('app-2')
    await reconnected.request('thread/list', {})
    await reconnected.respond(request.id, { decision: 'accept' })
    const seen = await app.until((message) => message.method === 'turn/completed')
    assert.ok(seen.some((message) => message.method === 'serverRequest/resolved'))
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          /mock approval/.test(message.params.delta),
      ),
      'the accepted command ran',
    )

    // An answer after the first is dropped, and the debug log says so.
    await app.respond(request.id, { decision: 'decline' })
    assert.deepEqual(ignoredResponses(debugLog), [['app', request.id, 'notPending']])
  })
})

test('each follower gets the subagent items it renders, whoever started the turn', {
  timeout: 20_000,
}, async () => {
  await withServer(async (connect) => {
    const current = connect('app')
    await current.request('initialize', {
      clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: '26.818.61809' },
      capabilities: { subAgentActivityCompleted: true },
    })
    const legacy = connect('app-legacy')
    await legacy.request('initialize', {
      clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: '26.818.61809' },
      capabilities: {},
    })
    const threadId = await startThread(current)
    await legacy.request('thread/resume', { threadId })

    const parentDone = (message: any) =>
      message.method === 'turn/completed' && message.params.threadId === threadId
    const subagentItems = (messages: any[]) => {
      const completed = messages
        .filter(
          (message) => message.method === 'item/completed' && message.params.threadId === threadId,
        )
        .map((message) => message.params.item)
      return {
        activity: completed
          .filter((item) => item.type === 'subAgentActivity')
          .map((item) => item.kind),
        closeAgent: completed.some(
          (item) => item.type === 'collabAgentToolCall' && item.tool === 'closeAgent',
        ),
      }
    }

    // The legacy App starts the turn; the current one still sees the child
    // finish.
    await legacy.request('turn/start', { threadId, input: textInput('subagent check') })
    const [done, doneLegacy] = [
      subagentItems(await current.until(parentDone)),
      subagentItems(await legacy.until(parentDone)),
    ]
    assert.deepEqual(done, { activity: ['started', 'completed'], closeAgent: false })
    assert.deepEqual(doneLegacy, { activity: [], closeAgent: false })

    // A child that never reports: only the legacy App needs the closeAgent,
    // though the current App started the turn.
    await current.request('turn/start', { threadId, input: textInput('orphan subagent check') })
    const [orphan, orphanLegacy] = [
      subagentItems(await current.until(parentDone)),
      subagentItems(await legacy.until(parentDone)),
    ]
    assert.deepEqual(orphan, { activity: ['started', 'interrupted'], closeAgent: false })
    assert.deepEqual(orphanLegacy, { activity: ['interrupted'], closeAgent: true })

    // Read back, each gets what it got live: the closeAgent kept for the
    // legacy App would hide the child from the current one.
    const isClose = (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'closeAgent'
    const closesIn = async (client: Client) => {
      const read = await client.request('thread/read', { threadId, includeTurns: true })
      const listed = await client.request('thread/items/list', { threadId })
      const updated = await client.request('thread/metadata/update', { threadId })
      const items = (thread: any) => thread.turns.flatMap((turn: any) => turn.items)
      return {
        read: items(read.result.thread).filter(isClose),
        listed: listed.result.data.map((entry: any) => entry.item).filter(isClose),
        updated: items(updated.result.thread).filter(isClose),
      }
    }
    assert.deepEqual(await closesIn(current), { read: [], listed: [], updated: [] })
    const kept = await closesIn(legacy)
    assert.equal(kept.read.length, 1)
    assert.deepEqual(kept.listed, kept.read)
    assert.deepEqual(kept.updated, kept.read)
    assert.equal('legacyOnly' in kept.read[0], false)
  })
})

test('unsubscribing stops one follower only', { timeout: 20_000 }, async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const b = await connect()
    const threadId = await startThread(a)
    await b.request('thread/resume', { threadId })

    const unsubscribed = await b.request('thread/unsubscribe', { threadId })
    assert.equal(unsubscribed.result.status, 'unsubscribed')
    await b.until((message) => message.method === 'thread/closed')
    assert.equal(
      (await b.request('thread/unsubscribe', { threadId })).result.status,
      'notSubscribed',
    )

    await a.request('turn/start', { threadId, input: textInput('only a hears this') })
    const seenA = await a.until((message) => message.method === 'turn/completed')
    assert.match(agentText(seenA), /only a hears this/)
    assert.equal(
      seenA.some((message) => message.method === 'thread/closed'),
      false,
    )
    const loaded = await a.request('thread/loaded/list', {})
    assert.deepEqual(loaded.result.data, [threadId])
    assert.equal(
      b.received.some((message) => message.method === 'turn/started'),
      false,
    )
  })
})

test('a client that disconnects takes its terminals and command/exec processes with it', {
  timeout: 30_000,
}, async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const b = await connect()
    // A shell that prints its pid, then waits as an open terminal does.
    const shell = ['sh', '-c', 'echo $$; exec sleep 300']
    const terminal = (processHandle: string, extra: Record<string, unknown> = {}) => ({
      processHandle,
      command: shell,
      cwd: process.cwd(),
      streamStdoutStderr: true,
      streamStdin: true,
      ...extra,
    })
    const pids: number[] = []
    const pidOf = async (peer: Client, key: string, id: string) => {
      pids.push(await printedPid(peer, key, id))
      return pids.at(-1) as number
    }
    try {
      // The App's terminal (a pty), a streamed process and a command/exec:
      // none of them has a timeout.
      await a.request('process/spawn', terminal('a-tty', { tty: true }))
      const aTty = await pidOf(a, 'processHandle', 'a-tty')
      await a.request('process/spawn', terminal('a-term'))
      const aTerm = await pidOf(a, 'processHandle', 'a-term')
      // command/exec answers when its process ends, which a closed client never hears.
      a.request('command/exec', {
        processId: 'a-exec',
        command: shell,
        cwd: process.cwd(),
        streamStdoutStderr: true,
        disableTimeout: true,
      }).catch(() => {})
      const aExec = await pidOf(a, 'processId', 'a-exec')
      // One that ignores SIGTERM.
      await a.request('process/spawn', {
        ...terminal('a-stubborn'),
        command: ['sh', '-c', 'trap "" TERM; echo $$; while :; do sleep 0.1; done'],
      })
      const aStubborn = await pidOf(a, 'processHandle', 'a-stubborn')
      await b.request('process/spawn', terminal('b-term'))
      const bTerm = await pidOf(b, 'processHandle', 'b-term')

      a.close()
      for (const pid of [aTty, aTerm, aExec])
        assert.ok(await exits(pid, 5_000), `process ${pid} of the closed client still runs`)
      assert.equal(isAlive(bTerm), true, 'the other client keeps its terminal')
      // A's handles are free at once, even one whose process has yet to exit.
      await b.request('process/spawn', terminal('a-stubborn'))
      const reused = await pidOf(b, 'processHandle', 'a-stubborn')
      assert.ok(await exits(aStubborn, 5_000), 'SIGKILL follows a SIGTERM that is ignored')
      // The old process's late exit leaves the handle to the new one.
      await delay(300)
      await b.request('process/kill', { processHandle: 'a-stubborn' })
      assert.ok(await exits(reused, 5_000), 'the reused handle names the new process')
      await b.request('process/kill', { processHandle: 'b-term' })
      assert.ok(await exits(bTerm, 5_000), 'process/kill ends the terminal')
    } finally {
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

interface Client {
  readonly received: any[]
  receive(message: any): void
  request(method: string, params: unknown): Promise<any>
  respond(id: unknown, result: unknown): Promise<void>
  until(predicate: (message: any) => boolean, timeoutMs?: number): Promise<any[]>
  close(): void
}

async function withDaemon(
  body: (connect: () => Promise<Client>) => Promise<void>,
  configure?: (home: string) => NodeJS.ProcessEnv,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_IDLE_EXIT_MS: '0',
      NODE_NO_WARNINGS: '1',
      ...configure?.(home),
    },
  })
  const sockets: WebSocket[] = []
  try {
    await waitForListening(proc)
    await body(async () => {
      const ws = new WebSocket('ws://localhost/', {
        createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
      })
      sockets.push(ws)
      await once(ws, 'open')
      const peer = client(
        (message) => ws.send(JSON.stringify(message)),
        () => ws.close(),
      )
      ws.on('message', (data) => peer.receive(JSON.parse(String(data))))
      return peer
    })
  } finally {
    for (const ws of sockets) {
      ws.on('error', () => {})
      ws.terminate()
    }
    if (proc.exitCode === null) {
      proc.kill()
      await once(proc, 'exit')
    }
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

// The server in this process, for tests that pick the peer ids or read the
// debug log.
async function withServer(
  body: (connect: (id: string) => Client, debugLog: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const env: Record<string, string | undefined> = {
    CLAUDE_CODEX_HOME: home,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    CLAUDE_CODEX_DEBUG_LOG: debugLog,
    CLAUDE_CODEX_SUBAGENT_COMPLETED: undefined,
  }
  const saved = Object.keys(env).map((name) => [name, process.env[name]] as const)
  const setEnv = (values: Iterable<readonly [string, string | undefined]>) => {
    for (const [name, value] of values) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  setEnv(Object.entries(env))
  const server = new CodexClaudeAppServer(
    new SessionStore(join(home, 'state.sqlite')),
    new MockRuntime(),
  )
  try {
    await body((id) => {
      const peer: RpcPeer = {
        id,
        // As over the wire: a copy, which later changes to the item miss.
        send: (message) => connection.receive(JSON.parse(JSON.stringify(message))),
        close: () => {},
      }
      const connection = client(
        (message) => server.handle(peer, message as WireMessage),
        () => {},
      )
      return connection
    }, debugLog)
  } finally {
    await server.stop()
    setEnv(saved)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

// `send` takes a message to the server; the transport hands each message
// back to `receive`.
function client(send: (message: object) => unknown, close: () => void): Client {
  const received: any[] = []
  let cursor = 0
  let nextId = 1
  const waiters = new Set<() => void>()
  const waitFor = (test: () => any, timeoutMs: number): Promise<any> =>
    new Promise((resolvePromise, reject) => {
      const check = () => {
        const value = test()
        if (value === undefined) return
        waiters.delete(check)
        clearTimeout(timer)
        resolvePromise(value)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`timed out; saw ${received.map((message) => message.method).join(',')}`))
      }, timeoutMs)
      waiters.add(check)
      check()
    })
  return {
    received,
    receive(message) {
      received.push(message)
      for (const waiter of waiters) waiter()
    },
    async request(method, params) {
      const id = `c${nextId++}`
      await send({ jsonrpc: '2.0', id, method, params })
      const response = await waitFor(
        () => received.find((message) => message.id === id && message.method === undefined),
        10_000,
      )
      assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`)
      return response
    },
    async respond(id, result) {
      await send({ jsonrpc: '2.0', id, result })
    },
    // Messages from where the last call stopped through the first match.
    async until(predicate, timeoutMs = 10_000) {
      const end = await waitFor(() => {
        for (let index = cursor; index < received.length; index += 1)
          if (predicate(received[index])) return index
        return undefined
      }, timeoutMs)
      const slice = received.slice(cursor, end + 1)
      cursor = end + 1
      return slice
    },
    close,
  }
}

// Workspace permissions, so a command asks for approval.
async function startThread(peer: Client): Promise<string> {
  const start = await peer.request('thread/start', {
    cwd: process.cwd(),
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    permissions: ':workspace',
  })
  return start.result.thread.id
}

function textInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }]
}

function agentText(messages: any[]): string {
  return messages
    .filter((message) => message.method === 'item/agentMessage/delta')
    .map((message) => message.params.delta)
    .join('')
}

// [peer, request id, reason] for each client answer the debug log says was ignored.
function ignoredResponses(debugLog: string): string[][] {
  return readFileSync(debugLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'rpc.responseFromClient.ignored')
    .map((entry) => [entry.peerId, entry.id, entry.reason])
}

function userMessages(messages: any[]): any[] {
  return messages.filter(
    (message) =>
      (message.method === 'item/started' || message.method === 'item/completed') &&
      message.params.item?.type === 'userMessage',
  )
}

// The pid a process printed first, from the output it streamed to `peer`.
async function printedPid(peer: Client, key: string, id: string): Promise<number> {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const printed = peer.received
      .filter((message) => message.params?.[key] === id && message.params.deltaBase64)
      .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString('utf8'))
      .join('')
    const pid = /^\s*(\d+)\s/.exec(printed)?.[1]
    if (pid) return Number(pid)
    await delay(20)
  }
  throw new Error(`${id} printed no pid`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exits(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > end) return false
    await delay(50)
  }
  return true
}

async function waitForListening(proc: ChildProcess): Promise<void> {
  let output = ''
  proc.stderr?.setEncoding('utf8')
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not start: ${output}`)), 10_000)
    proc.stderr?.on('data', (chunk: string) => {
      output += chunk
      if (/listening on/.test(output)) {
        clearTimeout(timer)
        resolvePromise()
      }
    })
    proc.once('exit', () => reject(new Error(`daemon exited: ${output}`)))
  })
}

test('both followers receive native turn events and the same approval resolves once', async () => {
  await withDaemon(async (connect) => {
    const a = await connect()
    const b = await connect()
    const threadId = (await a.request('thread/start', { model: 'gpt-6.1-sol' })).result.thread.id
    await b.request('thread/resume', { threadId })
    await a.request('turn/start', { threadId, input: textInput('hello') })
    const isApproval = (message: any) => message.method === 'item/commandExecution/requestApproval'
    const approval = (await a.until(isApproval)).at(-1)
    assert.equal((await b.until(isApproval)).at(-1).id, approval.id)
    await b.respond(approval.id, { decision: 'decline' })
    for (const peer of [a, b]) {
      const stream = await peer.until((message) => message.method === 'turn/completed')
      assert.deepEqual(
        stream
          .filter((message) => message.method === 'serverRequest/resolved')
          .map((message) => message.params.requestId),
        [approval.id],
      )
      assert.equal(
        stream.find((message) => message.method === 'item/agentMessage/delta').params.threadId,
        threadId,
      )
    }
  }, nativeCodexTestEnv)
})
