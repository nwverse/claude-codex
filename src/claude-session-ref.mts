import { nativeConfigRoot } from './claude-config-roots.mjs'
import { resolveClaudeModelProcess } from './model-profiles.mjs'
import type { ThreadRecord } from './types.mjs'
import { resolveClaudeModel } from './util.mjs'
import { defaultWorkflowTranscriptRoots } from './workflow-subagents.mjs'

// Thread.claudeSession: the Claude Code session a Claude thread's turns
// resume, the folder it was last written in, and the config dir it lives
// under. A client on the same computer that also reads Claude Code
// transcripts matches the thread to its transcript with it, instead of
// showing the conversation twice. The thread's `path` stays null: the App
// reads that as a Codex rollout.
export interface ClaudeSessionRef {
  id: string
  cwd: string
  // Absolute; null when the thread's model process profile is no longer
  // configured as it was when the thread started, so its folder is unknown.
  configDir: string | null
}

// The parts of a profile's child environment that place its config dir.
type ConfigDirEnv = { CLAUDE_CONFIG_DIR?: string; HOME?: string }

// How long a profile that could not be resolved stays unresolved before a
// Thread looks again.
const UNRESOLVED_RETRY_MS = 60_000

// A pinned fingerprint names one profile configuration, so one config dir:
// it is resolved once per fingerprint, not from the profiles and env files
// for every Thread.
const profileDirs = new Map<string, { env: ConfigDirEnv | null; until: number }>()

// The session of a thread whose turns run on the Claude Agent SDK, or null:
// a Codex thread, one before its first Claude turn, and the sessions of the
// HTTP bridges and the claude-p wrapper (prefixed ids, no SDK transcript)
// have none. The caller leaves out a fork that still names its parent's
// session.
export function claudeSessionRef(thread: ThreadRecord): ClaudeSessionRef | null {
  if (thread.runtimeBackend !== 'claude') return null
  const id = thread.claudeSessionId
  if (!id || id.includes(':')) return null
  const cwd = thread.claudeSessionCwd ?? thread.cwd
  return { id, cwd, configDir: sessionConfigDir(thread, cwd) }
}

// The config dir the thread's turns run with, as the native runtime picks it:
// its model process profile's CLAUDE_CONFIG_DIR, else the adapter's own (or
// the model's router config dir), else ~/.claude.
function sessionConfigDir(thread: ThreadRecord, cwd: string): string | null {
  const fingerprint = thread.modelProfileFingerprint ?? null
  if (!fingerprint) return nativeConfigRoot(routerModel(thread.model))
  const now = Date.now()
  let entry = profileDirs.get(fingerprint)
  if (!entry || (entry.env === null && entry.until <= now)) {
    entry = {
      env: profileConfigDirEnv(thread.model, fingerprint),
      until: now + UNRESOLVED_RETRY_MS,
    }
    profileDirs.set(fingerprint, entry)
  }
  if (!entry.env) return null
  // The CLI runs in the turn's folder, which a relative CLAUDE_CONFIG_DIR is
  // taken against.
  return defaultWorkflowTranscriptRoots(entry.env, cwd)[0] ?? null
}

// The model a custom CLI (a model router) picks a config dir for: the SDK
// model the thread's turns name. Only a router looks at it.
function routerModel(model: string): string | null {
  if (!process.env.CLAUDE_CODEX_CLI) return null
  try {
    return resolveClaudeModel(model)
  } catch {
    return model
  }
}

function profileConfigDirEnv(model: string, fingerprint: string): ConfigDirEnv | null {
  try {
    const profile = resolveClaudeModelProcess(model, process.env, fingerprint)
    if (!profile) return null
    const env: ConfigDirEnv = {}
    if (profile.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = profile.env.CLAUDE_CONFIG_DIR
    if (profile.env.HOME) env.HOME = profile.env.HOME
    return env
  } catch {
    // Gone, changed since the thread started, or unreadable right now.
    return null
  }
}
