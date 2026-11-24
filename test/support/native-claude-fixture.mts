import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const logFile = process.env.NATIVE_CLAUDE_FIXTURE_LOG
if (!logFile) throw new Error('NATIVE_CLAUDE_FIXTURE_LOG is required')

const modeArgument = process.argv.find((arg) => arg.startsWith('--permission-mode='))
let permissionMode = modeArgument?.slice('--permission-mode='.length) ?? 'default'
const sessionId = 'native-fixture-' + process.pid
let initialized = false
let buffer = ''

function log(entry) {
  appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

function reply(request, response = {}) {
  send({
    type: 'control_response',
    response: { subtype: 'success', request_id: request.request_id, response },
  })
}

function messageText(message) {
  const content = message?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .filter((text) => typeof text === 'string')
    .join('')
}

function handleControl(request) {
  const subtype = request.request?.subtype
  log({ event: 'control_request', subtype, mode: permissionMode })
  if (subtype === 'initialize') {
    initialized = true
    reply(request, { claude_code_version: '2.1.322' })
    return
  }
  if (subtype === 'set_permission_mode') {
    permissionMode = String(request.request.mode)
    log({ event: 'permission_mode', mode: permissionMode })
  }
  reply(request)
}

function handleUser(message) {
  if (!initialized) throw new Error('received a user message before initialize')
  const uuid = typeof message.uuid === 'string' ? message.uuid : null
  log({ event: 'turn', mode: permissionMode, uuid, text: messageText(message) })
  if (!handleUser.sentInit) {
    handleUser.sentInit = true
    send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: sessionId + '-init' })
  }
  send({
    type: 'assistant',
    uuid: sessionId + '-assistant-' + Date.now(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: sessionId + '-message-' + Date.now(),
      role: 'assistant',
      content: [{ type: 'text', text: 'native fixture response' }],
    },
  })
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'native fixture response',
    session_id: sessionId,
    num_turns: 1,
    ...(uuid ? { user_message_uuids: [uuid] } : {}),
  })
  send({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state: 'idle' })
}

function handle(message) {
  if (message?.type === 'control_request') return handleControl(message)
  if (message?.type === 'user') return handleUser(message)
}

log({ event: 'spawn', argv: process.argv.slice(2), permissionMode })
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('exit', () => log({ event: 'exit', mode: permissionMode }))
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    handle(JSON.parse(line))
  }
})
`

export interface NativeClaudeFixture {
  executable: string
  log: string
  env: NodeJS.ProcessEnv
}

export interface NativeClaudeEvent {
  event?: string
  mode?: string
  permissionMode?: string
  argv?: string[]
  pid?: number
  subtype?: string
  text?: string
  [key: string]: unknown
}

export async function nativeClaudeTestEnv(
  home: string,
  log = join(home, 'native-claude-fixture.jsonl'),
): Promise<NativeClaudeFixture> {
  const executable = join(home, 'fake-claude')
  await writeFile(executable, FAKE_CLAUDE, 'utf8')
  await chmod(executable, 0o755)
  await writeFile(log, '', 'utf8')
  return {
    executable,
    log,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      CLAUDE_CODEX_RUNTIME_TYPE: 'agent-sdk-sidecar',
      CLAUDE_CODEX_CLI: executable,
      CLAUDE_CODEX_REAP_ORPHANED_CLI: '0',
      CLAUDE_CODEX_IDLE_EXIT_MS: '0',
      CLAUDE_CODE_DISABLE_CRON: '1',
      NATIVE_CLAUDE_FIXTURE_LOG: log,
      NODE_NO_WARNINGS: '1',
    },
  }
}

export async function readNativeClaudeEvents(log: string): Promise<NativeClaudeEvent[]> {
  const text = await readFile(log, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NativeClaudeEvent)
}
