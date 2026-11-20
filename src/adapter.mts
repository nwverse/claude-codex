#!/usr/bin/env node
import { lstatSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { APP_PLUGIN_SERVER_ENV, setAppPluginConfigOverrides } from './app-plugin-mcp.mjs'
import { sweepCliMcpConfigs } from './cli-mcp-config.mjs'
import { reapOrphanedCliChildren } from './cli-orphans.mjs'
import { daemonProbe, listening, startupConfigProbe } from './cli-probes.mjs'
import { inheritedHooksWarning } from './inherited-config.mjs'
import { replaceJsonFile } from './json-file.mjs'
import { processStartTime } from './process-owner.mjs'
import { createRuntime } from './runtime-factory.mjs'
import { CodexClaudeAppServer } from './server.mjs'
import { SessionStore } from './store.mjs'
import {
  normalizeListenUrl,
  parseListenUrl,
  parseProxySockArg,
  prepareUnixSocketParent,
  prepareWebSocketAuth,
  type RunningTransport,
  removeStaleSocket,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from './transports.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog, defaultSocketPath, sleep } from './util.mjs'

// Install global crash guards FIRST, before anything else can fail. Without
// these, a single uncaught rejection or a synchronous EPIPE from a write to a
// half-closed peer (Codex App's SSH stream blipping mid-stream) silently kills
// the daemon — observed as pid churn (one daemon process per few minutes)
// with no error trace in debug.jsonl. Logging here puts the cause on disk
// AND keeps the daemon alive so the App's reconnect is a no-op.
function onUncaughtException(error: unknown): void {
  const err = error as NodeJS.ErrnoException
  const code = err?.code ?? null
  const isExpected = code === 'EPIPE' || code === 'ECONNRESET' || code === 'EBADF'
  debugLog('adapter.uncaughtException', {
    code,
    message: err?.message ?? String(error),
    stack: err?.stack ?? null,
    swallowed: isExpected,
  })
  // EPIPE/ECONNRESET from peer disconnects are routine; swallow them so the
  // daemon keeps serving other peers. Anything else: re-throw on next tick to
  // preserve normal error semantics (and we already logged it). The listener
  // comes off first: a throw it is still listening for comes straight back
  // here, and the process would log and re-throw forever instead of exiting.
  if (!isExpected) {
    process.off('uncaughtException', onUncaughtException)
    setImmediate(() => {
      throw error
    })
  }
}
process.on('uncaughtException', onUncaughtException)
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason as NodeJS.ErrnoException
  debugLog('adapter.unhandledRejection', {
    code: err?.code ?? null,
    message: err?.message ?? String(reason),
    stack: err?.stack ?? null,
  })
  // Node ≥ 15 defaults to crashing on unhandled rejection. Keep the daemon
  // up; we have logging now, so silent death is no longer a risk.
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] !== 'app-server') {
    usage(1)
    return
  }

  // One-shot probes, answered before the state database opens and before
  // startup recovery, so a probe cannot disturb a server already running.
  const probe = startupConfigProbe(args) ?? (await daemonProbe(args))
  if (probe) {
    process.stdout.write(probe.stdout)
    process.stderr.write(probe.stderr)
    process.exitCode = probe.code
    return
  }

  // An App plugin server the adapter runs may itself run `codex app-server`
  // (the code-review plugin does, for the Codex sign-in). Through the shim
  // that would start a second adapter on the same state, which would take
  // the running turns of this one for stale ones, or connect to this one.
  // App rule: code-review-plugin-server
  if (process.env[APP_PLUGIN_SERVER_ENV] === '1') {
    process.stderr.write(
      '[claude-codex-adapter] not started: App plugin servers cannot run the app-server\n',
    )
    process.exit(1)
  }

  const proxyIndex = args.indexOf('proxy')
  if (proxyIndex >= 0) {
    const socketPath = checkOptions(() => parseProxySockArg(args.slice(proxyIndex + 1)))
    await runProxy(socketPath)
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage(0)
    return
  }

  const listen = checkOptions(() => listenArg(args))
  if (listen === 'off') return
  const wsAuth = {
    auth: getArg(args, '--ws-auth'),
    tokenFile: getArg(args, '--ws-token-file'),
    tokenSha256: getArg(args, '--ws-token-sha256'),
    allowedOrigins: getArg(args, '--ws-allowed-origins'),
  }
  const allowUnauthenticated = args.includes('--ws-allow-unauthenticated')
  // Before anything else starts, so a listener that would be unprotected
  // fails without touching the store or other processes.
  const preparedWsAuth = checkOptions(() => {
    const normalizedListen = normalizeListenUrl(listen)
    if (normalizedListen !== 'stdio://') parseListenUrl(normalizedListen)
    if (
      !listen.startsWith('ws://') &&
      (allowUnauthenticated || Object.values(wsAuth).some((value) => value !== null))
    ) {
      throw new Error(
        '--ws-auth, --ws-token-file, --ws-token-sha256, --ws-allowed-origins and --ws-allow-unauthenticated need --listen ws://',
      )
    }
    return prepareWebSocketAuth(normalizeListenUrl(listen), { ...wsAuth, allowUnauthenticated })
  })
  // The App passes -c settings for the Codex config, the plugin servers it
  // wants among them.
  const configOverrides = configArgs(args)
  setAppPluginConfigOverrides(configOverrides)
  const isUnixDaemon = listen.startsWith('unix://')
  // From here on each startup step goes to the debug log as it ends.
  startupStep('options')
  const daemon = isUnixDaemon ? await ensureSingleUnixDaemon(listen) : null
  const pidFile = daemon?.pidFile ?? null

  const store = new SessionStore()
  startupStep('store')
  // The Codex App normally launches the app-server over stdio, so a crashed or
  // force-quit adapter leaves its last turn persisted as `inProgress`. The
  // next stdio process is the recovery boundary just like the unix daemon;
  // only recovering unix transports leaves the App's subagent view stuck on
  // "loading" forever after a restart.
  const recovered = store.recoverStaleInProgressTurns()
  startupStep('recovery')
  if (recovered > 0) {
    process.stderr.write(
      `[claude-codex-adapter] recovered ${recovered} stale in-progress turn(s)\n`,
    )
  }
  // Same boundary for processes: a killed adapter's CLI keeps writing the
  // session this process may resume, so stop it before serving.
  const reaped = await reapOrphanedCliChildren()
  startupStep('reap')
  if (reaped.length > 0) {
    process.stderr.write(
      `[claude-codex-adapter] stopped ${reaped.length} orphaned Claude CLI process(es)\n`,
    )
  }
  // And the MCP config files a killed adapter left for its CLI sessions.
  sweepCliMcpConfigs()
  // Bridged hooks run twice under a CLI that reads its own settings files.
  const hooksWarning = inheritedHooksWarning()
  if (hooksWarning) {
    debugLog('adapter.inheritedHooksWarning', { cli: Boolean(process.env.CLAUDE_CODEX_CLI) })
    process.stderr.write(`[claude-codex-adapter] ${hooksWarning}\n`)
  }
  const runtime = createRuntime()
  const server = new CodexClaudeAppServer(store, runtime, { configOverrides })
  startupStep('server')
  let transport: RunningTransport | null = null
  let shuttingDown = false
  const shutdown = async (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    debugLog('adapter.shutdown', { reason, pid: process.pid })
    let code = 0
    try {
      // The CLI record stays: a SIGTERMed CLI does not always exit with the
      // adapter, and the next adapter reaps whatever is left.
      await server.stop()
    } catch (error) {
      // shuttingDown already ignores the next signal, so a failed stop has to
      // end the process here or nothing will.
      code = 1
      const message = error instanceof Error ? error.message : String(error)
      debugLog('adapter.shutdown.failed', { reason, pid: process.pid, message })
      process.stderr.write(`[claude-codex-adapter] shutdown failed: ${message}\n`)
    }
    try {
      // Closing the listener removes its unix socket if no other process has
      // bound the path since. Bounded, so a close that hangs cannot keep the
      // process from exiting.
      await Promise.race([transport?.close(), sleep(2000)])
    } catch {}
    if (pidFile) {
      try {
        // Ours only, like the socket.
        if (Number(readFileSync(pidFile, 'utf8')) === process.pid) unlinkSync(pidFile)
      } catch {}
    }
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
  debugLog('adapter.start', { pid: process.pid, listen, isUnixDaemon })

  const onMessage = server.handle.bind(server)
  const normalized = normalizeListenUrl(listen)
  const isStdio = normalized === 'stdio://'

  // When the Codex client (app-server proxy) disconnects, a `unix://` daemon
  // would otherwise linger forever and keep its Claude runtime sidecar alive.
  // Exit once the last peer is gone so the runtime socket closes and the
  // sidecar is reclaimed. Codex App re-probes and restarts the daemon on
  // reconnect. Set CLAUDE_CODEX_IDLE_EXIT_MS=0 to keep the legacy persistent
  // behavior.
  const idleExitMs = Number(process.env.CLAUDE_CODEX_IDLE_EXIT_MS ?? 15000)
  const idleExitEnabled = isUnixDaemon && Number.isFinite(idleExitMs) && idleExitMs > 0
  let activePeers = 0
  let everConnected = false
  let idleTimer: NodeJS.Timeout | null = null
  const cancelIdleExit = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdleExit = () => {
    if (
      !idleExitEnabled ||
      activePeers > 0 ||
      !everConnected ||
      idleTimer ||
      server.hasActiveTurns()
    )
      return
    idleTimer = setTimeout(() => {
      idleTimer = null
      // Work can start with no peer connected while the timer runs (a queued
      // message, a goal continuation, Claude's own follow-up). It is left
      // alone, and its end checks idle again.
      if (activePeers > 0 || server.hasActiveTurns()) return
      debugLog('adapter.idleExit', { idleExitMs, pid: process.pid })
      process.stderr.write(
        `[claude-codex-adapter] no active peers for ${idleExitMs}ms, shutting down\n`,
      )
      void shutdown('idleExit')
    }, idleExitMs)
    idleTimer.unref()
  }
  server.setIdleCheckHandler(armIdleExit)
  const onConnect = (_peer: RpcPeer) => {
    everConnected = true
    activePeers += 1
    cancelIdleExit()
  }
  const onClose = (peer: RpcPeer) => {
    activePeers = Math.max(0, activePeers - 1)
    server.closePeer(peer)
    if (isStdio) {
      // A stdio peer is the process lifetime. If Codex closes its pipe during
      // reconnect, stop the runtime and terminalize all child turns before the
      // process exits; otherwise the old in-memory subagent can remain active
      // while the replacement adapter is already serving the same database.
      void shutdown('stdioClose')
      return
    }
    armIdleExit()
  }

  // Turn diffs older versions stored go in the background once the adapter
  // serves (see clearStoredTurnDiffs).
  if (normalized === 'stdio://') {
    startStdioTransport(onMessage, onClose)
    void store.clearStoredTurnDiffs()
    return
  }
  try {
    transport = await startWebSocketTransport(normalized, onMessage, onClose, onConnect, {
      ...(preparedWsAuth ? { auth: preparedWsAuth } : {}),
    })
    startupStep('listening')
  } catch (error) {
    // Another daemon bound the socket while this one started, as when both
    // started at the same moment and neither saw the other's pid file.
    if (!daemon || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    process.stderr.write(
      `[claude-codex-adapter] app-server already running at ${daemon.socketPath}\n`,
    )
    await shutdown('socketInUse')
    return
  }
  void store.clearStoredTurnDiffs()
}

interface UnixDaemon {
  socketPath: string
  pidFile: string
}

// A bad option ends the process with its message alone, like the usage text:
// a stack trace would read as a crash.
function checkOptions<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    return optionError(error)
  }
}

function optionError(error: unknown): never {
  process.stderr.write(
    `[claude-codex-adapter] ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}

// The --listen value, stdio:// when the flag is absent. `--listen` with no
// value, or followed by another flag, is an error rather than a silent stdio://.
function listenArg(args: string[]): string {
  const value = getArg(args, '--listen')
  if (args.includes('--listen') && (value === null || value.startsWith('-'))) {
    throw new Error('--listen needs a value')
  }
  return value ?? 'stdio://'
}

function getArg(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] ?? null
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

// The values of -c/--config key=value, in order.
function configArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if ((arg === '-c' || arg === '--config') && index + 1 < args.length)
      values.push(args[++index] as string)
    else if (arg.startsWith('--config=')) values.push(arg.slice('--config='.length))
  }
  return values
}

// How long a second daemon waits for one that is still starting to listen,
// or to exit so that it can take its place, before it leaves it to finish.
// A pid whose process start time ps cannot read gets only this long from
// the pid file's date, as it may belong to no daemon at all.
const DAEMON_STARTUP_GRACE_MS = 10_000
// How long the daemon a pid file names may go without listening before it is
// taken for hung (or a zombie no one reaps) and replaced. Counted from the
// file's date, which a touch, a restore or a sync can make later than the
// daemon's start. A slow daemon replaced this way is safe: whichever binds
// the socket second finds it taken and exits.
const DAEMON_STARTUP_LIMIT_MS = 60_000

async function ensureSingleUnixDaemon(listen: string): Promise<UnixDaemon> {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const pidFile = `${socketPath}.pid`
  const shared = checkOptions(() => prepareUnixSocketParent(socketPath))
  const pid = checkOptions(() => readDaemonPid(pidFile, shared))
  const state = pid === null ? null : await daemonState(pid, socketPath, pidFile)
  startupStep('pidFile', { filePid: pid, state })
  if (state) {
    process.stderr.write(
      `[claude-codex-adapter] app-server already ${state} at ${socketPath} (pid ${pid})\n`,
    )
    process.exit(0)
  }
  // The pid file may be stale. Only a socket that refuses a connection can be
  // reclaimed at the listen path.
  if (!(await removeStaleSocket(socketPath, shared).catch(optionError))) {
    process.stderr.write(`[claude-codex-adapter] app-server already running at ${socketPath}\n`)
    process.exit(0)
  }
  // In a sticky temporary directory publish the decimal pid by rename, without
  // following an entry which appeared while the daemon was starting.
  if (shared) replaceJsonFile(pidFile, process.pid)
  else writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  return { socketPath, pidFile }
}

// The pid in the file, or null when it is missing or could not name another
// daemon. Number('') is 0, and kill(0) or kill(-n) signals a process group,
// so only a plain positive pid other than init and this process counts.
function readDaemonPid(pidFile: string, shared: boolean): number | null {
  if (shared) {
    const entry = lstatSync(pidFile, { throwIfNoEntry: false })
    if (!entry) return null
    if (!entry.isFile() || entry.uid !== process.getuid?.())
      throw new Error(`expected an owned regular pid file at ${pidFile}`)
  }
  let text: string
  try {
    text = readFileSync(pidFile, 'utf8').trim()
  } catch {
    return null
  }
  if (!/^\d+$/.test(text)) return null
  const pid = Number(text)
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : null
}

// Whether the daemon the pid file names is running, still starting, or gone
// (null). A live pid is that daemon only if its process had started by the
// time the file was written; one that started later got the pid of a daemon
// that is gone, as after a reboot. The daemon itself is not taken for gone
// before the startup limit just because it does not listen yet: the store,
// startup recovery and ps can take well over 10 s on a loaded machine.
async function daemonState(
  pid: number,
  socketPath: string,
  pidFile: string,
): Promise<'running' | 'starting' | null> {
  let writtenAt: number
  try {
    writtenAt = statSync(pidFile).mtimeMs
  } catch {
    return null
  }
  if (!processIsAlive(pid)) return null
  const started = processStartTime(pid)
  if (started !== null && started > writtenAt) return null
  // A pid file dated in the future (clock stepped back, network file system)
  // counts from now, not from its date.
  const now = Date.now()
  const staleAt =
    Math.min(writtenAt, now) +
    (started === null ? DAEMON_STARTUP_GRACE_MS : DAEMON_STARTUP_LIMIT_MS)
  const waitUntil = now + DAEMON_STARTUP_GRACE_MS
  for (;;) {
    if (await listening(socketPath)) return 'running'
    if (Date.now() >= staleAt) return null
    if (Date.now() >= waitUntil) return 'starting'
    await sleep(200)
    if (!processIsAlive(pid)) return null
  }
}

// Logs that a startup step ended, at how many ms since the process started
// (module loading included). A start that is slow shows which step took the
// time; one that hangs, the last step it finished.
function startupStep(step: string, data: Record<string, unknown> = {}): void {
  debugLog('adapter.startup', { step, atMs: Math.round(performance.now()), ...data })
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usage(code: number): never {
  const text = `Usage:
  claude-codex-adapter app-server --listen stdio://
  claude-codex-adapter app-server --listen unix://
  claude-codex-adapter app-server --listen ws://127.0.0.1:8788
      [--ws-auth capability-token|none] [--ws-token-file ABS_PATH | --ws-token-sha256 HEX]
      [--ws-allowed-origins ORIGIN,...] [--ws-allow-unauthenticated]
  claude-codex-adapter app-server proxy [--sock PATH]
  claude-codex-adapter app-server --print-startup-config [--startup-client-info JSON]
  claude-codex-adapter app-server daemon version
`
  ;(code === 0 ? process.stdout : process.stderr).write(text)
  process.exit(code)
}

main().catch((error) => {
  process.stderr.write(
    `[claude-codex-adapter] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
