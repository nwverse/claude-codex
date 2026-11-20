import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// A shell that exports CLAUDE_CODEX_HOME (as the docs suggest for the workflow
// CLI, and as claude-codex-isolated does for its chats) would otherwise have
// the suites write mock threads and Full access defaults into that live home.
test('npm test preloads the environment scrub into every suite', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'))
  assert.match(scripts.test, /\bnode --test --import \.\/dist\/test\/support\/hermetic-env\.mjs /)
})

// This suite does not import the scrub itself, so it sees what the preload
// left: nothing of the caller's.
test("the preload starts a suite without the caller's Claude, Codex or Anthropic environment", (t) => {
  if (!process.execArgv.some((arg) => arg.includes('hermetic-env')))
    return t.skip('run without the npm test preload')
  const leaked = Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE|CODEX_)/.test(key))
  assert.deepEqual(leaked, [])
})

test('a single adapter suite run without the preload leaves a live adapter home alone', {
  timeout: 60_000,
}, async () => {
  const trap = await mkdtemp(join(tmpdir(), 'claude-codex-trap-'))
  const env = { ...process.env }
  // It would make the child report to this runner instead.
  delete env.NODE_TEST_CONTEXT
  try {
    const child = spawn(process.execPath, ['--test', 'dist/test/fixtures/harness-turn.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        CLAUDE_CODEX_HOME: join(trap, 'adapter-home'),
        CLAUDE_CODEX_DEBUG_LOG: join(trap, 'debug.jsonl'),
        CLAUDE_CODEX_RUN_LOG: join(trap, 'runs.jsonl'),
      },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
    assert.match(output, /pass 1\b/)
    assert.deepEqual(await readdir(trap), [])
  } finally {
    await rm(trap, { recursive: true, force: true })
  }
})
