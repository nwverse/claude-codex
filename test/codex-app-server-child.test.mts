import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexAppServerChild } from '../src/codex-app-server-child.mjs'

// A fake `codex app-server` that starts a helper in its process group (as an
// MCP server would run) and exits when asked to, as a crash would.
const FAKE_CODEX = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const helper = spawn('sleep', ['300'], { stdio: 'ignore' })
fs.writeFileSync(process.env.FAKE_HELPER_PID_FILE, String(helper.pid))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline) || '{}')
    buffer = buffer.slice(newline + 1)
    if (message.method === 'crash') process.exit(3)
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  }
})
`

test('a codex app-server that exits on its own takes the rest of its process group with it', {
  timeout: 20_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-child-'))
  const helperFile = join(dir, 'helper.pid')
  writeFileSync(join(dir, 'fake-codex.cjs'), FAKE_CODEX)
  const binary = join(dir, 'codex')
  writeFileSync(
    binary,
    `#!/bin/sh\nFAKE_HELPER_PID_FILE='${helperFile}' exec '${process.execPath}' '${join(dir, 'fake-codex.cjs')}' "$@"\n`,
  )
  chmodSync(binary, 0o755)
  const exits: string[] = []
  const child = new CodexAppServerChild(
    'openai',
    {
      notification() {},
      serverRequest() {},
      exited: (_provider, _generation, reason) => exits.push(reason),
    },
    { clientInfo: () => ({ name: 'test', version: '0' }), binary: () => binary },
  )
  let helper = 0
  try {
    await child.request('thread/list', {})
    helper = Number(readFileSync(helperFile, 'utf8'))
    assert.ok(isAlive(helper), 'the helper runs')

    await assert.rejects(child.request('crash', {}), /exited \(3\)/)

    assert.deepEqual(exits, ['exited (3)'])
    assert.ok(await gone(helper, 5_000), `helper ${helper} outlived codex`)
  } finally {
    await child.close()
    if (helper && isAlive(helper)) process.kill(helper, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > end) return false
    await delay(50)
  }
  return true
}
