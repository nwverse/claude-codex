import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_CODEX = `
const fs = require('node:fs')
const provider = (process.argv.findLast((arg) => arg.startsWith('model_provider=')) || '').slice(15).replace(/"/g, '')
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ provider, ...entry }) + '\\n')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
log({event:'spawn', argv:process.argv.slice(2),pid:process.pid})
process.on('exit', () => log({event:'exit'}))
if (process.env.FAKE_IGNORE_TERM) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else process.on('SIGTERM', () => process.exit(0))
const models = new Map()
const waiting = new Map()
let next = 0
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
function handle(message) {
  log(message)
  if (message.method === undefined) {
    const resume = waiting.get(message.id)
    if (resume) { waiting.delete(message.id); resume(message.result) }
    return
  }
  const p = message.params || {}
  const reply = (result) => send({ id: message.id, result })
  switch (message.method) {
    case 'initialize': return reply({ userAgent: 'fake' })
    case 'initialized': return
    case 'thread/start': {
      const id = provider + '-thread-' + (++next)
      models.set(id, p.model)
      send({ method: 'thread/started', params: { thread: { id, modelProvider: provider } } })
      return reply({ thread: { id, modelProvider: provider, turns: [] }, model: p.model, modelProvider: provider })
    }
    case 'thread/fork': {
      const id = provider + '-fork-' + (++next)
      models.set(id, p.model || models.get(p.threadId))
      return reply({thread:{id, modelProvider:provider, forkedFromId:p.threadId, turns:[{id:'turn-old'}]},model:models.get(id),modelProvider:provider})
    }
    case 'thread/archive':
    case 'thread/delete':
      if (process.env.FAKE_REFUSE_CHANGES) return send({id:message.id,error:{code:-32000,message:'rollout unavailable'}})
      return reply({})
    case 'thread/unarchive':
      return reply({thread:{id:p.threadId, modelProvider:provider, turns:[]}})
    case 'turn/interrupt':
      send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted',items:[]}}})
      return reply({})
    case 'thread/read':
    case 'thread/resume':
      if (p.model) models.set(p.threadId, p.model)
      return reply({ thread: { id: p.threadId, modelProvider: provider, turns: [{ id: 'turn-old' }] }, model: models.get(p.threadId) || 'unknown', modelProvider: provider })
    case 'thread/settings/update':
      if (p.model) models.set(p.threadId, p.model)
      return reply({})
    case 'turn/start': {
      const turnId = 'turn-' + (++next)
      if (process.env.FAKE_IMMEDIATE_COMPLETION) {
        const turn = {id:turnId, status:'inProgress', items:[]}
        const batch = [{id:message.id,result:{turn}}, {method:'turn/started',params:{threadId:p.threadId,turn}},
          {method:'turn/completed',params:{threadId:p.threadId,turn:{...turn,status:'completed'}}}]
        return process.stdout.write(batch.map(line => JSON.stringify(line)).join('\\n')+'\\n')
      }
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } })
      send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } })
      send({method:'thread/status/changed',params:{threadId:p.threadId,status:{type:'active',activeFlags:['waitingOnApproval']}}})
      const requestId = 900 + next
      waiting.set(requestId, (result) => {
        send({ method: 'serverRequest/resolved', params: { threadId: p.threadId, requestId } })
        const text = provider + ':' + models.get(p.threadId) + ':' + (result && result.decision)
        send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, itemId: 'm1', delta: text } })
        send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed', items: [] } } })
      })
      send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId, itemId: 'c1', command: 'ls' } })
      return
    }
    default: return reply({})
  }
}
`

export function nativeCodexTestEnv(home: string): NodeJS.ProcessEnv {
  const script = join(home, 'fake-codex.cjs')
  writeFileSync(script, FAKE_CODEX)
  const binary = join(home, 'codex')
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(binary, 0o755)
  const log = join(home, 'fake.log')
  writeFileSync(log, '')
  return {
    HOME: home,
    CODEX_HOME: home,
    CLAUDE_CODEX_HOME: join(home, 'adapter'),
    CLAUDE_CODEX_MOCK: '1',
    CLAUDE_CODEX_NATIVE_CODEX: 'on',
    CLAUDE_CODEX_CODEX_MODELS: 'gpt-6.1-sol',
    CLAUDE_CODEX_CODEX_AG_MODELS: 'claude-opus-5-5',
    CODEX_REAL: binary,
    FAKE_CODEX_LOG: log,
    NODE_NO_WARNINGS: '1',
  }
}
