import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  recordRunEvent,
  redactRunRegistryData,
  runRegistryEntry,
  runRegistryPath,
} from '../src/run-registry.mjs'

test('run registry redacts prompt-like fields and secret-like values', () => {
  const entry = runRegistryEntry('turn.started', {
    threadId: 'thread-a',
    prompt: 'do not store me',
    nested: {
      message: 'token=secret123456789',
      safe: 'model-name',
    },
  })

  assert.equal(entry.prompt, '[redacted]')
  assert.deepEqual(entry.nested, {
    message: 'token=[redacted]',
    safe: 'model-name',
  })
})

test('run registry can be disabled without touching the filesystem', () => {
  const path = runRegistryPath({ CLAUDE_CODEX_RUN_LOG: '0' })
  const result = recordRunEvent(
    'thread.started',
    { threadId: 'thread-a' },
    { CLAUDE_CODEX_RUN_LOG: '0' },
  )

  assert.equal(path, null)
  assert.deepEqual(result, { ok: true, path: null, error: null })
})

test('run registry appends redacted JSONL entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-run-registry-'))
  const path = join(dir, 'runs.jsonl')

  const result = recordRunEvent(
    'turn.completed',
    { threadId: 'thread-a', responseText: 'raw answer', note: 'api_key=secret123456789' },
    { CLAUDE_CODEX_RUN_LOG: path },
  )
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>

  assert.equal(result.ok, true)
  assert.equal(entry.event, 'turn.completed')
  assert.equal(entry.responseText, '[redacted]')
  assert.equal(entry.note, 'api_key=[redacted]')
})

// A daemon appends on every thread, turn and subagent event and may never
// restart, so the registry rotates as debug.jsonl does.
test('run registry rotates at the debug log limits and keeps every file owner-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-run-registry-'))
  const path = join(dir, 'runs.jsonl')
  const env = {
    CLAUDE_CODEX_RUN_LOG: path,
    CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES: '400',
    CLAUDE_CODEX_DEBUG_LOG_KEEP: '2',
  }
  try {
    for (let i = 0; i < 40; i += 1) {
      assert.equal(recordRunEvent('turn.started', { threadId: `thread-${i}` }, env).ok, true)
    }
    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, ['runs.jsonl', 'runs.jsonl.1', 'runs.jsonl.2'])
    const lineBytes = (await readFile(path, 'utf8')).indexOf('\n') + 1
    for (const file of files) {
      const info = await stat(join(dir, file))
      assert.ok(info.size < 400 + lineBytes, file)
      assert.equal((info.mode & 0o777).toString(8), '600', file)
    }
    // The newest events stay, in order, across the files that are kept.
    const threads: unknown[] = []
    for (const file of ['runs.jsonl.2', 'runs.jsonl.1', 'runs.jsonl']) {
      for (const line of (await readFile(join(dir, file), 'utf8')).trim().split('\n'))
        threads.push(JSON.parse(line).threadId)
    }
    const first = Number(String(threads[0]).split('-')[1])
    assert.deepEqual(
      threads,
      Array.from({ length: 40 - first }, (_, i) => `thread-${first + i}`),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('run registry redactor preserves arrays and primitive metadata', () => {
  assert.deepEqual(redactRunRegistryData(['safe', { input: 'hidden' }, 1]), [
    'safe',
    { input: '[redacted]' },
    1,
  ])
})
