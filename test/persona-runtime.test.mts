import assert from 'node:assert/strict'
import { type ChildProcess, fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { adapter, delay, stopProcess } from './support/adapter-harness.mjs'

type Row = {
  session_id: string
  status: string
  updated_at: string
  model: string
  effort: string
  capabilities: { modes: boolean; model: boolean }
}

test('desktop acknowledges the same observed turn leaving the same host unread list', async () => {
  const { DesktopReads } = await import(
    pathToFileURL(resolve('scripts/persona/desktop-read.mjs')).href
  )
  const dir = await mkdtemp(join(tmpdir(), 'cc-persona-desktop-'))
  const file = join(dir, 'app-state.json')
  const reads = new DesktopReads(file)
  const receipts: string[] = []
  let revision = 0
  async function snapshot(ids: string[], turn: string, host = 'remote-ssh-test') {
    await writeFile(
      file,
      JSON.stringify({
        revision: '.'.repeat(++revision),
        'electron-thread-read-state-v1': { unreadByIdentity: { account: { [host]: ids } } },
      }),
    )
    reads.update(new Map([['thread', turn]]), (_id: string, observed: string) =>
      receipts.push(observed),
    )
  }
  try {
    await snapshot([], 'first')
    await snapshot(['thread'], 'first')
    await snapshot([], 'second')
    await snapshot(['thread'], 'second')
    await snapshot([], 'second', 'remote-ssh-other')
    assert.deepEqual(receipts, [])
    await snapshot(['thread'], 'second')
    await snapshot([], 'second')
    assert.deepEqual(receipts, ['second'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function driver(env: NodeJS.ProcessEnv) {
  const child = fork(resolve('scripts/persona/bridge.mjs'), [], { env, silent: true, execArgv: [] })
  const [ready] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => {
      throw new Error(`Companion exited on startup with ${code}`)
    }),
  ])
  assert.equal(ready.ready, true)
  const waiting = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  let next = 0
  child.on('message', (m: { id: number; result?: any; error?: string }) => {
    const call = waiting.get(m.id)
    if (!call) return
    waiting.delete(m.id)
    if (m.error) call.reject(new Error(m.error))
    else call.resolve(m.result)
  })
  child.once('exit', () => {
    for (const call of waiting.values()) call.reject(new Error('Companion exited'))
  })
  function call(method: string, params: object = {}): Promise<any> {
    const id = ++next
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      child.send({ id, method, params })
    })
  }
  return { child, call }
}

test('Persona resumes the owning thread, confirms choices, and remembers which turn was read', {
  timeout: 30000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cc-persona-'))
  const socket = join(home, 'adapter.sock')
  const profiles = join(home, 'profiles.json')
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    CLAUDE_CODEX_MODEL_PROFILES_FILE: profiles,
    CLAUDE_CODEX_PERSONA_APP_SERVER: socket,
    CLAUDE_CODEX_PERSONA_SDK: resolve('test/fixtures/persona-sdk.mjs'),
  }
  const processes: ChildProcess[] = []
  try {
    await writeFile(
      profiles,
      JSON.stringify({
        defaultModel: 'gateway-a',
        models: [
          { id: 'gateway-a', sdkModel: 'claude-a' },
          { id: 'gateway-b', sdkModel: 'gpt-gateway-model' },
        ],
      }),
      { mode: 0o600 },
    )
    const daemon = spawn(
      process.execPath,
      [adapter, 'app-server', '--listen', `unix://${socket}`],
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    processes.push(daemon)
    let startup = ''
    daemon.stderr.on('data', (chunk) => {
      startup += chunk
    })
    for (let i = 0; !existsSync(socket) && daemon.exitCode === null && i < 300; i++) await delay(15)
    assert.ok(existsSync(socket), startup)
    let api = await driver(env)
    processes.push(api.child)
    const start = { cwd: home, model: 'claude-a', effort: 'high', client_msg_id: 'new' }
    const { session } = await api.call('start', start)
    const p = { session_id: session.session_id }
    async function row(status: string): Promise<Row> {
      for (let i = 0; i < 150; i++) {
        const rows: Row[] = await api.call('listSessions')
        const current = rows.find((r) => r.session_id === p.session_id)
        if (current?.status === status) return current
        await delay(20)
      }
      throw new Error(`Thread did not become ${status}`)
    }
    const modelList = await api.call('models')
    assert.ok(modelList.models.some((m: { id: string }) => m.id === 'gpt-gateway-model'))
    assert.equal((await row('idle')).model, 'claude-a')
    assert.equal((await row('idle')).capabilities.model, true)
    assert.equal((await api.call('start', start)).session.session_id, p.session_id)
    await api.call('modes', { ...p, model: 'gateway-b', effort: 'medium' })
    assert.equal((await row('idle')).model, 'gpt-gateway-model')
    await api.call('modes', { ...p, model: 'gateway-a', effort: 'high' })
    await assert.rejects(
      api.call('modes', { ...p, model: 'gpt-native', effort: 'low' }),
      /unavailable/,
    )
    await assert.rejects(api.call('modes', { ...p, effort: 'invented' }), /does not offer/)
    const first = { ...p, text: 'first phone turn', client_msg_id: 'message-1' }
    await api.call('send', first)
    const completed = await row('done')
    assert.deepEqual(completed.capabilities, { modes: true, model: false })
    assert.equal(completed.effort, 'high')
    await assert.rejects(
      api.call('modes', { ...p, model: 'gpt-gateway-model', effort: 'low' }),
      /new thread/,
    )
    assert.equal((await row('done')).effort, 'high')
    await api.call('modes', { ...p, model: 'claude-a', effort: 'low' })
    assert.equal((await row('done')).effort, 'low')
    await api.call('seen', p)
    assert.equal((await row('idle')).updated_at, completed.updated_at)
    await stopProcess(api.child)
    api = await driver(env)
    processes.push(api.child)
    await api.call('send', first)
    await api.call('rename', { ...p, title: 'new title' })
    assert.equal((await row('idle')).updated_at, completed.updated_at)
    await api.call('send', { ...p, text: 'another turn', client_msg_id: 'message-2' })
    await row('done')
    const { session: other } = await api.call('start', {
      ...start,
      model: 'gpt-gateway-model',
      client_msg_id: 'different',
    })
    assert.notEqual(other.session_id, p.session_id)
    assert.equal(other.model, 'gpt-gateway-model')
    await api.call('archive', p)
    assert.equal((await api.call('listSessions')).length, 1)
    await api.call('unarchive', p)
    assert.equal((await row('done')).session_id, p.session_id)
  } finally {
    for (const process of processes.reverse()) await stopProcess(process)
    await rm(home, { recursive: true, force: true })
  }
})
