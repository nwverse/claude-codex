import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const modeScript = resolve('scripts/claude-codex-mode')

async function runMode(stateDir: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_STATE_DIR: stateDir,
    // Never read the developer's real runtime.env.
    CLAUDE_CODEX_RUNTIME_ENV: join(stateDir, 'runtime.env'),
  }
  // Nor the developer's adapter home.
  for (const key of ['CLAUDE_CODEX_DEBUG_LOG', 'CLAUDE_CODEX_HOME', 'CODEX_HOME']) delete env[key]
  const { stdout } = await execFileAsync('bash', [modeScript, ...args], { env, timeout: 20_000 })
  return stdout
}

async function bridgeLog(stateDir: string, mode: string, key: string, text: string, age: number) {
  const dir = join(stateDir, 'bridges', mode, key)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'log')
  await writeFile(log, `${text}\n`)
  const when = new Date(Date.now() - age * 1000)
  await utimes(log, when, when)
  return dir
}

test('logs <bridge> shows the pooled bridge log written to most recently', async () => {
  // A space in the path: pool folders used to be word-split.
  const stateDir = await mkdtemp(join(tmpdir(), 'claude-codex-mode logs-'))
  try {
    const oldestDir = await bridgeLog(stateDir, 'agentapi', 'aaaaaaaaaaaaaaaa', 'oldest', 7200)
    const newestDir = await bridgeLog(stateDir, 'agentapi', 'bbbbbbbbbbbbbbbb', 'newest', 0)
    await bridgeLog(stateDir, 'agentapi', 'cccccccccccccccc', 'middle', 3600)
    // A folder touched later (a new pid file) does not make an older log the latest.
    const old = new Date(Date.now() - 600_000)
    await utimes(newestDir, old, old)
    // The oldest log's folder is the oldest folder too, as in the issue's repro.
    const twoHoursAgo = new Date(Date.now() - 7_200_000)
    await utimes(oldestDir, twoHoursAgo, twoHoursAgo)
    await bridgeLog(stateDir, 'agent-http', 'dddddddddddddddd', 'other mode', 0)

    assert.equal(await runMode(stateDir, 'logs', 'agentapi', '5'), 'newest\n')
    assert.equal(await runMode(stateDir, 'logs', 'agent-http', '5'), 'other mode\n')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('logs <bridge> falls back to the legacy log without pooled bridges', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'claude-codex-mode-logs-'))
  try {
    await mkdir(join(stateDir, 'bridges', 'agentapi', 'eeeeeeeeeeeeeeee'), { recursive: true })
    await writeFile(join(stateDir, 'agentapi.log'), 'legacy\n')

    assert.equal(await runMode(stateDir, 'logs', 'agentapi', '5'), 'legacy\n')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('logs adapter reads debug.jsonl in the adapter home runtime.env names', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'claude-codex-mode logs-'))
  try {
    const writeLog = async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${text}\n`)
    }
    const codexHome = join(stateDir, 'codex home')
    const adapterHome = join(stateDir, 'adapter home')
    const explicit = join(stateDir, 'explicit', 'debug.jsonl')
    await writeLog(join(codexHome, 'claude-codex-adapter', 'debug.jsonl'), 'codex home')
    await writeLog(join(adapterHome, 'debug.jsonl'), 'adapter home')
    await writeLog(explicit, 'explicit')
    const runtimeEnv = async (...lines: string[]) =>
      writeFile(join(stateDir, 'runtime.env'), `${lines.join('\n')}\n`)

    await runtimeEnv(`export CODEX_HOME='${codexHome}'`)
    assert.equal(await runMode(stateDir, 'logs', 'adapter', '5'), 'codex home\n')

    await runtimeEnv(
      `export CODEX_HOME='${codexHome}'`,
      `export CLAUDE_CODEX_HOME='${adapterHome}'`,
    )
    assert.equal(await runMode(stateDir, 'logs', 'adapter', '5'), 'adapter home\n')

    await runtimeEnv(
      `export CLAUDE_CODEX_HOME='${adapterHome}'`,
      `export CLAUDE_CODEX_DEBUG_LOG='${explicit}'`,
    )
    assert.equal(await runMode(stateDir, 'logs', 'adapter', '5'), 'explicit\n')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
