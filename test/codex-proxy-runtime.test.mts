import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import {
  awaitMessage,
  JsonLineReader,
  json,
  sendTurn,
  spawnMockAdapter,
  stopProcess,
} from './support/adapter-harness.mjs'

// Keep debug.jsonl out of the developer's ~/.codex.
process.env.CLAUDE_CODEX_DEBUG_LOG = '0'

// A fake `codex` that records its argv (one per line) and its stdin, then
// prints the smallest JSONL turn the proxy accepts.
const FAKE_CODEX = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CODEX_DIR/argv"
cat > "$FAKE_CODEX_DIR/stdin"
echo '{"type":"thread.started","thread_id":"fake-session"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`

async function runFakeTurn(
  prompt: string,
  claudeSessionId: string | null,
): Promise<{ argv: string[]; stdin: string; events: RuntimeEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-test-'))
  const binary = join(dir, 'codex')
  writeFileSync(binary, FAKE_CODEX)
  chmodSync(binary, 0o755)
  const saved = { real: process.env.CODEX_REAL, dir: process.env.FAKE_CODEX_DIR }
  process.env.CODEX_REAL = binary
  process.env.FAKE_CODEX_DIR = dir
  const events: RuntimeEvent[] = []
  try {
    const context = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      prompt,
      cwd: dir,
      runtimeType: null,
      model: 'gpt-test',
      effort: null,
      claudeSessionId,
      forkSession: false,
      mcpServers: null,
      allowedTools: null,
    } as unknown as RuntimeTurnContext
    const handlers: RuntimeHandlers = {
      onEvent: (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => {
        throw new Error('codex-proxy never asks for permission')
      },
    }
    await new CodexProxyRuntime().runTurn(context, handlers)
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1)
    return { argv, stdin: readFileSync(join(dir, 'stdin'), 'utf8'), events }
  } finally {
    if (saved.real === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = saved.real
    if (saved.dir === undefined) delete process.env.FAKE_CODEX_DIR
    else process.env.FAKE_CODEX_DIR = saved.dir
    rmSync(dir, { recursive: true, force: true })
  }
}

const DASH_PROMPT = '--explain this flag'
// Over Linux's 128 KiB limit for one argv string (MAX_ARG_STRLEN).
const LONG_PROMPT = 'x'.repeat(200_000)

for (const [label, sessionId] of [
  ['fresh', null],
  ['resume', 'prior-session'],
] as const) {
  for (const [kind, prompt] of [
    ['a prompt starting with --', DASH_PROMPT],
    ['a prompt over 200 KB', LONG_PROMPT],
  ] as const) {
    test(`codex-proxy ${label} turn passes ${kind} on stdin`, async () => {
      const { argv, stdin, events } = await runFakeTurn(prompt, sessionId)
      assert.equal(argv.at(-1), '-')
      assert.ok(!argv.includes(prompt), 'the prompt must not be an argv entry')
      assert.equal(argv[0], 'exec')
      if (sessionId) assert.deepEqual(argv.slice(-3), ['resume', sessionId, '-'])
      else assert.ok(!argv.includes('resume'))
      assert.equal(stdin, prompt)
      const completed = events.find((event) => event.type === 'completed')
      assert.ok(completed && completed.type === 'completed' && completed.success)
    })
  }
}

// A sandbox value the adapter does not know, on thread/metadata/update,
// thread/resume or thread/fork, leaves a thread with none stored, and the App
// is told it is workspace-write. codex exec used to run it unsandboxed.
test('a codex-proxy thread with no stored sandbox runs codex exec workspace-write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-test-'))
  const binary = join(dir, 'codex')
  writeFileSync(binary, FAKE_CODEX)
  chmodSync(binary, 0o755)
  // Not mock mode: there a gpt-* thread runs on the mock runtime.
  const proc = spawnMockAdapter(dir, {
    CLAUDE_CODEX_MOCK: '',
    CODEX_REAL: binary,
    FAKE_CODEX_DIR: dir,
    CLAUDE_CODEX_CODEX_MODELS: 'gpt-test',
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  const request = async (method: string, params: Record<string, unknown>): Promise<any> => {
    id += 1
    proc.stdin.write(json({ id, method, params }))
    const response = await reader.nextResponse(id)
    assert.equal(response.error, undefined, method)
    return response.result
  }
  // The sandbox flags the thread's next turn passes to codex exec.
  const sandboxFlags = async (threadId: string): Promise<string[]> => {
    id += 1
    sendTurn(proc, id, threadId, 'hi')
    await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n')
    return argv[3] === '-s' ? argv.slice(3, 5) : argv.slice(3, 4)
  }
  const fullAccess = ['--dangerously-bypass-approvals-and-sandbox']
  try {
    const started = await request('thread/start', { cwd: dir, model: 'gpt-test' })
    const threadId = started.thread.id
    assert.equal(started.sandbox.type, 'workspaceWrite')
    assert.deepEqual(await sandboxFlags(threadId), ['-s', 'workspace-write'])
    await request('thread/resume', { threadId, sandbox: 'danger-full-access' })
    assert.deepEqual(await sandboxFlags(threadId), fullAccess)

    await request('thread/metadata/update', { threadId, sandbox: 'granular' })
    assert.equal((await request('thread/resume', { threadId })).sandbox.type, 'workspaceWrite')
    assert.deepEqual(await sandboxFlags(threadId), ['-s', 'workspace-write'])

    await request('thread/resume', { threadId, sandbox: 'danger-full-access' })
    const resumed = await request('thread/resume', { threadId, sandbox: 'granular' })
    assert.equal(resumed.sandbox.type, 'workspaceWrite')
    assert.deepEqual(await sandboxFlags(threadId), ['-s', 'workspace-write'])

    await request('thread/resume', { threadId, sandbox: 'danger-full-access' })
    const fork = await request('thread/fork', { threadId, sandbox: 'granular' })
    assert.equal(fork.sandbox.type, 'workspaceWrite')
    assert.deepEqual(await sandboxFlags(fork.thread.id), ['-s', 'workspace-write'])
    assert.deepEqual(await sandboxFlags(threadId), fullAccess)
  } finally {
    await stopProcess(proc)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
