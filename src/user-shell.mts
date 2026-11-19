// A user-typed thread/shellCommand. It has no interactive stdin. Its output
// is drained continuously, including after the live and persisted byte cap.
import { spawn } from 'node:child_process'
import { signalProcessGroup } from './process-group.mjs'

const OUTPUT_BYTES = 1_000_000
const DIAGNOSTIC_BYTES = 256
const PIPE_DRAIN_MS = 2_000
const MAX_TIMER_MS = 2_147_483_647

export interface UserShellRun {
  done: Promise<void>
  stop(message: string): void
}

interface ShellResult {
  exitCode: number
  aggregatedOutput: string
  durationMs: number
  aborted: boolean
  timedOut: boolean
  signal: NodeJS.Signals | null
}

// setEncoding keeps characters whole between reads. When the byte budget cuts
// through a character, discard its incomplete bytes.
function bytePrefix(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  const bytes = Buffer.from(text)
  let end = limit
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.toString('utf8', 0, end)
}

export function startUserShell(
  cwd: string,
  command: string,
  timeoutMs: number,
  onOutput: (delta: string) => void,
  onFinish: (result: ShellResult) => void,
): UserShellRun {
  const startedAt = Date.now()
  const chunks: string[] = []
  let remaining = OUTPUT_BYTES - DIAGNOSTIC_BYTES
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let drain: NodeJS.Timeout | undefined
  let child: ReturnType<typeof spawn> | undefined
  let release = () => {}
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const emit = (delta: string) => {
    if (!delta) return
    chunks.push(delta)
    onOutput(delta)
  }
  const output = (text: string) => {
    if (settled || remaining === 0) return
    const delta = bytePrefix(text, remaining)
    remaining = delta.length === text.length ? remaining - Buffer.byteLength(delta) : 0
    emit(delta)
  }
  const finish = (
    exitCode: number,
    diagnostic = '',
    aborted = false,
    timedOut = false,
    signal: NodeJS.Signals | null = null,
  ) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(drain)
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    try {
      if (diagnostic) emit(bytePrefix(`\n${diagnostic}\n`, DIAGNOSTIC_BYTES))
      onFinish({
        exitCode,
        aggregatedOutput: chunks.join(''),
        durationMs: Math.max(0, Date.now() - startedAt),
        aborted,
        timedOut,
        signal,
      })
    } finally {
      release()
    }
  }
  const terminate = (message: string, timedOut: boolean) => {
    if (settled) return
    if (child) signalProcessGroup(child, 'SIGKILL')
    finish(-1, message, !timedOut, timedOut, 'SIGKILL')
  }
  const stop = (message: string) => terminate(message, false)
  const checkTimeout = () => {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs > 0) timer = setTimeout(checkTimeout, Math.min(remainingMs, MAX_TIMER_MS))
    else terminate('Timeout', true)
  }
  try {
    child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    // The caller registers the run before its first terminal callback.
    queueMicrotask(() => finish(1, error instanceof Error ? error.message : String(error)))
    return { stop, done }
  }
  child.stdout?.setEncoding('utf8').on('data', output)
  child.stderr?.setEncoding('utf8').on('data', output)
  child.once('error', (error) => finish(1, error.message))
  child.once('exit', (code, signal) => {
    if (settled) return
    clearTimeout(timer)
    // Descendants can inherit the pipes after the shell itself has exited.
    drain = setTimeout(() => finish(code ?? 1, '', false, false, signal), PIPE_DRAIN_MS)
  })
  child.once('close', (code, signal) => finish(code ?? 1, '', false, false, signal))
  timer = setTimeout(checkTimeout, Math.min(timeoutMs, MAX_TIMER_MS))
  return { stop, done }
}
