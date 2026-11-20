import type { ChildProcess } from 'node:child_process'

const COMMAND_EXEC_KILL_GRACE_MS = 1_000

// Stops under way: a second stop waits for the first instead of signalling
// the group again.
const stopping = new WeakMap<ChildProcess, Promise<void>>()

// Signals a child's process group when it leads one (spawned detached),
// else the child alone.
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Not a group leader, or the group is gone: fall back to the child.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already gone.
  }
}

// SIGTERM to the group, then SIGKILL to whatever ignores it, after a grace
// period or as soon as the leader exits: what it started (or forked as the
// group was signalled) can outlive it. Never later, as once Node has reaped
// the leader and the rest of its group is gone, its id may be reused. Settles
// when the SIGKILL has gone out, so a caller about to exit, which would drop
// the timer, can wait for it.
export function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pending = stopping.get(child)
  if (pending) return pending
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const stopped = new Promise<void>((resolve) => {
    const kill = () => {
      clearTimeout(timer)
      child.off('exit', kill)
      signalProcessGroup(child, 'SIGKILL')
      resolve()
    }
    const timer = setTimeout(kill, COMMAND_EXEC_KILL_GRACE_MS)
    timer.unref()
    child.once('exit', kill)
  })
  stopping.set(child, stopped)
  signalProcessGroup(child, 'SIGTERM')
  return stopped
}
