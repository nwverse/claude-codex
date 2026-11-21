import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// The Claude Code config dirs a session's transcripts live under, for a turn
// that runs without a model process profile (a profile names its own, see
// model-profiles.mts). The native runtime resumes sessions from them, and the
// server names a thread's one on Thread (claude-session-ref.mts).

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
