import { execFileSync } from 'node:child_process'
import { parseProcessRows, psEnv } from './cli-orphans.mjs'

// Several servers can share one state dir: the App's own, a second window, a
// one-shot `codex app-server` probe. Each turn records the server that wrote
// it, so a server that starts later fails only the turns of servers that are
// gone. A server is named by its pid and its start time, as in cli-orphans,
// so a pid the system has since handed to another process does not count as
// the server still running.

export interface ProcessOwner {
  pid: number
  started: string | null
}

let self: ProcessOwner | undefined

// Even where ps cannot read a start time, record the pid so other live
// adapters know to leave this process alone.
export function currentProcessOwner(): ProcessOwner {
  if (self === undefined) {
    const started = startTimes([process.pid])?.get(process.pid)
    self = { pid: process.pid, started: started ?? null }
  }
  return self
}

// Whether `owner` is another process that is still running. A pid that
// answers a signal but whose start time cannot be read (ps failed or timed
// out) counts as running: a live owner must never be mistaken for a dead one.
// It is gone when its pid is gone, or its start time differs from one read.
export function otherProcessRunning(owner: ProcessOwner): boolean {
  if (owner.pid === process.pid || !signalable(owner.pid)) return false
  if (!owner.started) return true
  const started = startTimes([owner.pid])?.get(owner.pid)
  return started === undefined ? signalable(owner.pid) : started === owner.started
}

// When the process with this pid started, in ms since the epoch to the whole
// second ps prints, or null when ps cannot tell: the process is gone, or ps
// is missing, has no lstart (BusyBox), timed out or printed a date that does
// not parse.
export function processStartTime(pid: number): number | null {
  const started = startTimes([pid])?.get(pid)
  // In the C locale and UTC, lstart reads "Mon Oct 12 02:52:58 2026".
  const time = started === undefined ? Number.NaN : Date.parse(`${started} UTC`)
  return Number.isFinite(time) ? time : null
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Start times by pid, or null when ps could not run. psEnv makes every
// server print the same start time for a process, whatever locale or time
// zone it was started with.
function startTimes(pids: number[]): Map<number, string> | null {
  if (process.platform === 'win32') return null
  let output: string
  try {
    output = execFileSync(
      'ps',
      ['-ww', '-o', 'pid=,ppid=,lstart=,command=', '-p', pids.join(',')],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: psEnv(),
      },
    )
  } catch (error) {
    // ps exits 1 when none of the pids is running.
    const failed = error as { status?: number | null; stdout?: unknown }
    if (failed.status !== 1) return null
    output = typeof failed.stdout === 'string' ? failed.stdout : ''
  }
  return new Map(parseProcessRows(output).map((row) => [row.pid, row.started]))
}
