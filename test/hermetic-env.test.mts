import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A shell that exports CLAUDE_CODEX_HOME (as the docs suggest for the workflow
// CLI, and as claude-codex-isolated does for its chats) would otherwise have
// the suites write mock threads and Full access defaults into that live home.
test('npm test preloads the environment scrub into every suite', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'))
  assert.match(scripts.test, /\bnode --test --import \.\/dist\/test\/support\/hermetic-env\.mjs /)
})

test("a suite starts without the caller's Claude, Codex or Anthropic environment", () => {
  const leaked = Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE|CODEX_)/.test(key))
  assert.deepEqual(
    leaked,
    [],
    'run the suites with npm test, or add --import ./dist/test/support/hermetic-env.mjs',
  )
})
