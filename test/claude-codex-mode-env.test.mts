import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

// Only the writer: `set` and `model` also stop every app-server on the host.
const rewriteEnvValue = spawnSync(
  'sed',
  ['-n', '/^rewrite_env_value() {/,/^}/p', resolve('scripts/claude-codex-mode')],
  { encoding: 'utf8' },
).stdout

function rewrite(envFile: string, key: string, value: string) {
  const script = `set -euo pipefail\n${rewriteEnvValue}\nENV_FILE="$1"\nshift\nrewrite_env_value "$@"`
  return spawnSync('bash', ['-c', script, 'bash', envFile, key, value], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('claude-codex-mode writes runtime.env values the shell reads back as written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-mode-env-'))
  try {
    const marker = join(root, 'ran')
    const values = [
      '/x $(echo X)',
      '/q"uote',
      '/$HOMEx',
      "it's",
      'opus[1m]',
      join(root, 'my project'),
      `\`touch ${marker}\` $(touch ${marker})`,
      'back\\slash',
      '',
    ]
    const envFile = join(root, 'runtime.env')
    // A line written before values were quoted, and one for another key.
    await writeFile(envFile, 'export V0="old"\nexport CLAUDE_CODEX_NODE="/opt/node bin/node"\n')
    for (const [i, value] of values.entries()) {
      const result = rewrite(envFile, `V${i}`, value)
      assert.equal(result.status, 0, result.stderr)
    }
    const text = await readFile(envFile, 'utf8')
    assert.equal(text.match(/^export V0=/gm)?.length, 1, text)

    const names = ['CLAUDE_CODEX_NODE', ...values.map((_, i) => `V${i}`)]
    const printVars = `printf '%s\\0' ${names.map((name) => `"$${name}"`).join(' ')}`
    const realCodex = join(root, 'real-codex')
    await writeFile(realCodex, `#!/bin/sh\n${printVars}\n`)
    await chmod(realCodex, 0o755)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CODEX_RUNTIME_ENV: envFile,
      CODEX_REAL: realCodex,
    }
    for (const key of ['CLAUDE_CODEX_ROUTE', 'CLAUDE_CODEX_RUNTIME_TYPE']) delete env[key]
    const readers = [
      spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\n${printVars}`, 'bash', envFile], {
        encoding: 'utf8',
        timeout: 10_000,
      }),
      // The shim sources it each time the App starts an app-server.
      spawnSync(resolve('scripts/codex-shim'), ['exec'], {
        env,
        encoding: 'utf8',
        timeout: 10_000,
      }),
    ]
    for (const read of readers) {
      assert.equal(read.status, 0, read.stderr)
      assert.deepEqual(read.stdout.split('\0').slice(0, -1), ['/opt/node bin/node', ...values])
    }
    assert.equal(existsSync(marker), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('claude-codex-mode refuses a value with a line break and leaves runtime.env as it was', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-mode-env-'))
  try {
    const envFile = join(root, 'runtime.env')
    assert.equal(rewrite(envFile, 'CLAUDE_CODEX_DEFAULT_MODEL', 'sonnet').status, 0)
    const before = await readFile(envFile, 'utf8')
    for (const value of ['opus\nexport CLAUDE_CODEX_RUNTIME_TYPE=codex', 'opus\rx']) {
      const result = rewrite(envFile, 'CLAUDE_CODEX_DEFAULT_MODEL', value)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /refusing to write CLAUDE_CODEX_DEFAULT_MODEL: .*line break/)
      assert.equal(await readFile(envFile, 'utf8'), before)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
