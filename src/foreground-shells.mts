import type { RuntimeEvent } from './types.mjs'

interface ShellExit {
  taskId: string
  status: string
  summary: string
}

// A foreground Bash call can return a task ID when its timeout expires.
// Its command item then belongs to that task until the CLI reports its exit.
export class ForegroundShells {
  private calls = new Map<string, ShellExit | null>()
  readonly running = new Map<string, string>()
  // The CLI can start turns for unrelated tasks on the same session.
  private replyRuns = new Set<string>()

  start(toolUseId: string): void {
    this.calls.set(toolUseId, null)
  }

  handoff(
    toolUseId: string,
    result: Record<string, unknown> | null,
  ): { exit: ShellExit | null } | null {
    const earlyExit = this.calls.get(toolUseId)
    this.calls.delete(toolUseId)
    if (earlyExit === undefined || !result) return null
    const { backgroundTaskId, timedOutAfterMs } = result
    if (
      typeof backgroundTaskId !== 'string' ||
      !backgroundTaskId ||
      typeof timedOutAfterMs !== 'number' ||
      !Number.isFinite(timedOutAfterMs) ||
      timedOutAfterMs <= 0 ||
      result.backgroundedByUser === true ||
      result.backgroundEndsWithFinalResponse === true ||
      result.interrupted === true
    )
      return null
    if (earlyExit?.taskId === backgroundTaskId) return { exit: earlyExit }
    this.running.set(backgroundTaskId, toolUseId)
    return { exit: null }
  }

  notified(exit: ShellExit, toolUseId: string | null, queuedRun: string | null): string | null {
    const call = this.running.get(exit.taskId)
    if (call) {
      this.running.delete(exit.taskId)
      if (queuedRun) this.replyRuns.add(queuedRun)
      return call
    }
    // A fast shell may exit before the SDK delivers the tool result.
    if (toolUseId && this.calls.has(toolUseId)) this.calls.set(toolUseId, exit)
    return null
  }

  acceptsReply(runId: string): boolean {
    if (!this.replyRuns.size) return true
    if (!this.replyRuns.has(runId)) return false
    // The CLI can fold several notifications into one response.
    this.replyRuns.clear()
    return true
  }
}

export function shellExitEvent(toolUseId: string, exit: ShellExit): RuntimeEvent {
  const code = /\bexit code[: ]+(-?\d+)\)?\.?$/i.exec(exit.summary)
  return {
    type: 'tool_result',
    toolUseId,
    content: exit.summary,
    isError: exit.status !== 'completed',
    commandExitCode: code ? Number(code[1]) : null,
  }
}
