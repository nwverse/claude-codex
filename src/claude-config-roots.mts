import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveClaudeModelProcess } from './model-profiles.mjs'
import type { RuntimeSessionRef } from './types.mjs'
import { resolveClaudeModel } from './util.mjs'
import { defaultWorkflowTranscriptRoots } from './workflow-subagents.mjs'

// The Claude Code config dirs a session's transcripts live under: a model
// process profile's own (see model-profiles.mts), else the ones below. The
// native runtime resumes sessions from them, and names the one a thread's
// transcript is in for Thread.claudeSession (sdkSessionTranscript).

// The sessions of the HTTP bridges and the claude-p wrapper: prefixed ids,
// with no Agent SDK transcript.
export const BRIDGE_SESSION_ID = /^(agent-http|agentapi|claude-p):/

// The config dir a turn without a model process profile runs from. The CLI
// the SDK starts reads CLAUDE_CONFIG_DIR, else ~/.claude. A custom CLI
// (CLAUDE_CODEX_CLI) may be a model router that runs each model from its own
// config dir, the ones the model list is discovered from (util.mts).
export function nativeConfigRoot(model: string | null | undefined): string {
  const own = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  if (!model || !process.env.CLAUDE_CODEX_CLI) return own
  if (basename(model) !== model || model === '.' || model === '..') return own
  for (const parent of routerConfigParents()) {
    const root = join(parent, model)
    if (isDirectory(root)) return root
  }
  return own
}

// Every config dir a session may have run from: the adapter's own, the
// CLAUDE_CONFIG_DIRS (or CLAUDE_ROUTER_DIR) entries, and the router config
// dirs under them and under ~/.cache/*/claude-router.
export function knownConfigRoots(): string[] {
  const roots = [join(homedir(), '.claude')]
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR)
  for (const extra of extraConfigRoots()) {
    if (existsSync(extra)) roots.push(extra)
  }
  for (const parent of routerConfigParents()) {
    try {
      for (const item of readdirSync(parent)) roots.push(join(parent, item))
    } catch {}
  }
  return roots
}

function extraConfigRoots(): string[] {
  return (process.env.CLAUDE_CONFIG_DIRS || process.env.CLAUDE_ROUTER_DIR || '')
    .split(/[,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

// Folders whose subfolders are per-model router config dirs.
function routerConfigParents(): string[] {
  const parents = extraConfigRoots().filter(isDirectory)
  const cacheBase = join(homedir(), '.cache')
  try {
    for (const sub of readdirSync(cacheBase)) {
      const routerDir = join(cacheBase, sub, 'claude-router')
      if (isDirectory(routerDir)) parents.push(routerDir)
    }
  } catch {}
  return parents
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// The parts of a profile's child environment that place its config dir.
type ConfigDirEnv = { CLAUDE_CONFIG_DIR?: string; HOME?: string }

// How long a config dir looked up for a Thread is used before it is looked
// up again: a profile that could not be resolved, and a router's config dir,
// which takes listing ~/.cache to find.
const LOOKUP_TTL_MS = 60_000

// A pinned fingerprint names one profile configuration, so one config dir:
// it is resolved once per fingerprint, not from the profiles and env files
// for every Thread.
const profileDirs = new Map<string, { env: ConfigDirEnv | null; until: number }>()
// A router's config dir for a thread without a profile, by the SDK model and
// the settings it is looked up from.
const routerDirs = new Map<string, { dir: string; until: number }>()

// Where the Agent SDK keeps the transcript of a thread's session: the config
// dir the native runtime runs the thread's turns with. Null for the sessions
// of the bridges, which have none.
export function sdkSessionTranscript(
  session: RuntimeSessionRef,
): { configDir: string | null } | null {
  if (BRIDGE_SESSION_ID.test(session.sessionId)) return null
  return { configDir: sessionConfigDir(session) }
}

// The thread's model process profile's CLAUDE_CONFIG_DIR, else the adapter's
// own (or the model's router config dir), else ~/.claude. Null when the
// profile is no longer configured as it was when the thread started.
function sessionConfigDir(session: RuntimeSessionRef): string | null {
  const now = Date.now()
  const fingerprint = session.modelProfileFingerprint
  if (!fingerprint) return routerConfigRoot(routerModel(session.model), now)
  let entry = profileDirs.get(fingerprint)
  if (!entry || (entry.env === null && entry.until <= now)) {
    entry = { env: profileConfigDirEnv(session.model, fingerprint), until: now + LOOKUP_TTL_MS }
    profileDirs.set(fingerprint, entry)
  }
  if (!entry.env) return null
  // The CLI runs in the turn's folder, which a relative CLAUDE_CONFIG_DIR is
  // taken against.
  return defaultWorkflowTranscriptRoots(entry.env, session.cwd)[0] ?? null
}

// nativeConfigRoot, with a router's dir reused for a while: Thread asks for
// every thread it returns, and a client may list hundreds every few seconds.
function routerConfigRoot(model: string | null, now: number): string {
  // Without a router the dir is CLAUDE_CONFIG_DIR or ~/.claude.
  if (!model) return nativeConfigRoot(null)
  const env = process.env
  const key = [
    model,
    env.CLAUDE_CONFIG_DIR,
    env.CLAUDE_CONFIG_DIRS,
    env.CLAUDE_ROUTER_DIR,
    homedir(),
  ].join('\0')
  const cached = routerDirs.get(key)
  if (cached && cached.until > now) return cached.dir
  const dir = nativeConfigRoot(model)
  routerDirs.set(key, { dir, until: now + LOOKUP_TTL_MS })
  return dir
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
