import type { ChildProcess } from 'node:child_process'

const COMMAND_EXEC_KILL_GRACE_MS = 1_000

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

// SIGTERM to the group, then SIGKILL to whatever ignores it.
export function stopProcessGroup(child: ChildProcess): void {
  signalProcessGroup(child, 'SIGTERM')
  const kill = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), COMMAND_EXEC_KILL_GRACE_MS)
  kill.unref()
}
