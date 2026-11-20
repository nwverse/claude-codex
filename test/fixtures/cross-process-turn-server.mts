import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexClaudeAppServer } from '../../src/server.mjs'
import { SessionStore } from '../../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, WireMessage } from '../../src/types.mjs'

const home = process.env.CLAUDE_CODEX_TEST_HOME
if (!home) throw new Error('CLAUDE_CODEX_TEST_HOME is required')
const holdTurn = process.env.CLAUDE_CODEX_TEST_HOLD_TURN === '1'
const releaseFile = join(home, 'release-turn')
const runLog = join(home, 'model-runs.jsonl')

const store = new SessionStore(join(home, 'state.sqlite'))
const queueBarrier = process.env.CLAUDE_CODEX_TEST_QUEUE_BARRIER === '1'
const queueBarrierSkip = Number(process.env.CLAUDE_CODEX_TEST_QUEUE_BARRIER_SKIP ?? '0')
const queueBarrierArm = join(home, 'queue-barrier-armed')
const queueBarrierRelease = join(home, 'release-queue-read')
const listQueue = store.listQueue.bind(store)
let queueBarrierReads = 0
let queueBarrierUsed = false
store.listQueue = (threadId) => {
  const items = listQueue(threadId)
  if (!queueBarrier || queueBarrierUsed || !existsSync(queueBarrierArm)) return items
  queueBarrierReads += 1
  if (queueBarrierReads <= queueBarrierSkip) return items
  queueBarrierUsed = true
  writeFileSync(join(home, `queue-read-${process.pid}`), 'ready')
  const waiting = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 1000 && !existsSync(queueBarrierRelease); attempt += 1) {
    Atomics.wait(waiting, 0, 0, 10)
  }
  if (!existsSync(queueBarrierRelease)) throw new Error('timed out waiting to release queue read')
  return items
}
store.recoverStaleInProgressTurns()
const runtime: ClaudeRuntime = {
  runTurn: async (context, handlers) => {
    appendFileSync(
      runLog,
      `${JSON.stringify({ pid: process.pid, threadId: context.threadId, turnId: context.turnId })}\n`,
    )
    await handlers.onEvent({ type: 'text_delta', delta: 'model started' })
    if (holdTurn) {
      for (let attempt = 0; attempt < 1000 && !existsSync(releaseFile); attempt += 1) {
        await delay(10)
      }
      if (!existsSync(releaseFile)) throw new Error('timed out waiting to release the model run')
    }
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  },
  steer: async (_threadId, _prompt, options) => {
    options?.onAccepted?.()
    return true
  },
  interrupt: async () => {},
  stop: async () => {},
}
const server = new CodexClaudeAppServer(store, runtime)
const peer: RpcPeer = {
  id: 'cross-process-fixture',
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  close: () => {},
}
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line.trim()) void server.handle(peer, JSON.parse(line) as WireMessage)
})

let stopping = false
process.on('SIGTERM', () => {
  if (stopping) return
  stopping = true
  void server.stop().finally(() => process.exit(0))
})
