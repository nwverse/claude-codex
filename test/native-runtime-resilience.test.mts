import './support/hermetic-env.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatSessionExitError, NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

const adapterHome = mkdtempSync(join(tmpdir(), 'native-runtime-resilience-home-'))
process.env.CLAUDE_CODEX_HOME = adapterHome
process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI = '0'
test.after(() => rmSync(adapterHome, { recursive: true, force: true, maxRetries: 5 }))

const baseContext: RuntimeTurnContext = {
  threadId: 'thread-resilience',
  turnId: 'turn-1',
  prompt: 'hello',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

class FakeResilienceQuery implements AsyncIterable<Record<string, unknown>> {
  prompts: Record<string, unknown>[] = []
  modes: string[] = []
  models: Record<string, unknown>[] = []
  closed = false
  private queue: Array<Record<string, unknown> | { throwError: Error }> = []
  private wake: (() => void) | null = null

  constructor(prompt: AsyncIterable<Record<string, unknown>>) {
    void (async () => {
      for await (const message of prompt) this.prompts.push(message)
    })()
  }

  push(...messages: Record<string, unknown>[]): void {
    this.queue.push(...messages)
    this.notify()
  }

  fail(error: Error): void {
    this.queue.push({ throwError: error })
    this.notify()
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode)
  }

  async supportedModels(): Promise<Record<string, unknown>[]> {
    return this.models
  }

  async interrupt(): Promise<void> {}

  close(): void {
    this.closed = true
    this.notify()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        if ('throwError' in next && next.throwError instanceof Error) throw next.throwError
        yield next as Record<string, unknown>
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

function makeHandlers(events: RuntimeEvent[]): RuntimeHandlers {
  return {
    onEvent: async (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
  }
}

async function waitFor<T>(fn: () => T | undefined | false | null, label: string): Promise<T> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('formatSessionExitError strips benign unrecognized_model stderr and explains POSIX signal exits', () => {
  const sigterm = formatSessionExitError(
    new Error(
      'Claude Code process exited with code 143. stderr: [claude-code:unrecognized_model] {"model":"gpt-6.2-astra","query_source":"sdk"}',
    ),
  )
  assert.equal(sigterm.message, 'Claude Code process was terminated by SIGTERM (exit code 143).')
  const withWindowNotice = formatSessionExitError(
    new Error(
      'Claude Code process exited with code 143. stderr: Claude Code doesn\'t recognize the model "gpt-6.2-astra", so it assumes a context window of 200k tokens.\n[claude-code:unrecognized_model] {"model":"gpt-6.2-astra","query_source":"sdk"}',
    ),
  )
  assert.equal(
    withWindowNotice.message,
    'Claude Code process was terminated by SIGTERM (exit code 143).',
  )

  const mixed = formatSessionExitError(
    new Error(
      'Claude Code process exited with code 1. stderr: [claude-code:unrecognized_model] {"model":"gpt-6.2-astra","query_source":"sdk"}\nError: EACCES: permission denied',
    ),
  )
  assert.equal(
    mixed.message,
    'Claude Code process exited with code 1. stderr: Error: EACCES: permission denied',
  )

  const sigkill = formatSessionExitError(new Error('Claude Code process exited with code 137'))
  assert.equal(sigkill.message, 'Claude Code process was killed by SIGKILL (exit code 137).')

  const unrelated = new Error('network reset')
  assert.equal(formatSessionExitError(unrelated), unrelated)
})

test('native runtime surfaces sanitized exit-143 error instead of unrecognized_model telemetry', async () => {
  const queries: FakeResilienceQuery[] = []
  const runtime = new NativeClaudeRuntime()
  ;(runtime as unknown as { sdk: unknown }).sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      const q = new FakeResilienceQuery(prompt)
      queries.push(q)
      return q
    },
  }
  const events: RuntimeEvent[] = []
  const turn = runtime.runTurn(baseContext, makeHandlers(events))
  const query = await waitFor(() => queries[0], 'session')
  query.push({ type: 'system', subtype: 'init', session_id: 's-143' })
  query.fail(
    new Error(
      'Claude Code process exited with code 143. stderr: [claude-code:unrecognized_model] {"model":"gpt-6.2-astra","query_source":"sdk"}',
    ),
  )
  await assert.rejects(turn, /Claude Code process was terminated by SIGTERM \(exit code 143\)\./)
  const errorEvent = events.find((event) => event.type === 'error')
  assert.equal(
    errorEvent?.type === 'error' ? errorEvent.message : null,
    'Claude Code process was terminated by SIGTERM (exit code 143).',
  )
  await runtime.stop()
})

test('native auto review declines custom models missing from supportedModels catalog', async () => {
  const queries: FakeResilienceQuery[] = []
  const runtime = new NativeClaudeRuntime()
  ;(runtime as unknown as { sdk: unknown }).sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      const q = new FakeResilienceQuery(prompt)
      q.models = [
        {
          value: 'opus',
          resolvedModel: 'claude-opus-5-5',
          displayName: 'Opus',
          supportsAutoMode: true,
        },
      ]
      queries.push(q)
      return q
    },
  }
  const events: RuntimeEvent[] = []
  const turn = runtime.runTurn(
    { ...baseContext, model: 'gpt-6.2-astra', autoReview: true },
    makeHandlers(events),
  )
  const query = await waitFor(() => queries[0], 'session')
  await waitFor(() => query.prompts.length === 1, 'prompt')
  query.push(
    { type: 'system', subtype: 'init', session_id: 's-custom' },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-custom' },
  )
  await turn
  assert.deepEqual(query.modes, [])
  assert.deepEqual(
    events.filter((event) => event.type === 'auto_review_unavailable'),
    [{ type: 'auto_review_unavailable', reason: 'gpt-6.2-astra does not support auto mode' }],
  )
  await runtime.stop()
})

test('native runtime exits auto mode immediately when the server-side classifier is unavailable', async () => {
  const queries: FakeResilienceQuery[] = []
  const runtime = new NativeClaudeRuntime()
  ;(runtime as unknown as { sdk: unknown }).sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      const q = new FakeResilienceQuery(prompt)
      q.models = [{ value: 'sonnet', displayName: 'Sonnet', supportsAutoMode: true }]
      queries.push(q)
      return q
    },
  }
  const events: RuntimeEvent[] = []
  const turn = runtime.runTurn(
    { ...baseContext, model: 'sonnet', autoReview: true },
    makeHandlers(events),
  )
  const query = await waitFor(() => queries[0], 'session')
  await waitFor(() => query.prompts.length === 1, 'prompt')
  query.push(
    { type: 'system', subtype: 'init', session_id: 's-clf' },
    {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Agent',
      tool_use_id: 'call-agent-1',
      decision_reason_type: 'classifier',
      decision_reason: 'Classifier unavailable',
    },
    {
      type: 'system',
      subtype: 'notification',
      key: 'auto-unavailable',
      priority: 'high',
      color: 'error',
      text: 'Auto mode is unavailable — the server returned no safety verdict.',
    },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-clf' },
  )
  await turn
  assert.deepEqual(query.modes, ['auto', 'default'])
  assert.deepEqual(
    events.filter((event) => event.type === 'auto_review_unavailable'),
    [{ type: 'auto_review_unavailable', reason: 'Classifier unavailable' }],
  )
  await runtime.stop()
})
