import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { domainToASCII } from 'node:url'
import type { HookMatcher } from './sdk-hooks.mjs'
import { COMMAND_NAMES_IGNORE_CASE, commandCandidates } from './shell-commands.mjs'
import { mayMatch, UNKNOWN } from './wildcards.mjs'

// The ask rules of the user's Claude Code settings (permissions.ask). The
// CLI takes no ask rules outside a settings file, so a PreToolUse callback
// stands in for them: a call a rule covers gets the 'ask' decision, which
// sends it to the permission prompt (the Codex approval) even when an allow
// rule or a hook would have let it run. Rules are matched as Claude Code
// matches them, erring towards asking: a Bash rule covers each command of
// a compound command line and what a wrapper such as `timeout` or `sh -c`
// runs, a word the shell expands could be any text, and a command line
// whose commands cannot be told apart (command substitution, a heredoc, a
// shell reading its commands from stdin, a zsh glob group) is asked about
// under any Bash rule, since it could run anything (see shell-commands.mts).
// File rules match paths without regard to case, as Claude Code does, and
// through symlinks. A call the guard cannot check is asked about.

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']
const SEARCH_TOOLS = ['Glob', 'Grep', 'LS']
// Tools Claude Code has renamed, by their old names, which rules may use.
const RENAMED: Record<string, string> = {
  Brief: 'SendUserMessage',
  KillBash: 'TaskStop',
  KillShell: 'TaskStop',
  ListMcpResources: 'ListMcpResourcesTool',
  ListPeers: 'ListAgents',
  ReadMcpResource: 'ReadMcpResourceTool',
  ReadMcpResourceDir: 'ReadMcpResourceDirTool',
  Task: 'Agent',
}
// Longer than any path the system opens (x/../ repeated can still reach a
// file through a shorter one): such a path is asked about, not taken apart.
const MAX_PATH = 4096

// What one tool call is checked with: the session's folder at the time (a
// relative path starts from it, and from the thread's folder too) and the
// commands of each Bash command line, read once for all rules.
export interface AskCall {
  readonly cwd?: string | undefined
  readonly commands?: Map<string, readonly string[] | null>
}

// The PreToolUse matcher that asks before the calls `rules` cover. `cwd` is
// the thread's folder: a rule's relative paths start from it, as they do
// for the rules the CLI takes on its command line.
export function askRulesGuard(rules: readonly string[], cwd: string): HookMatcher {
  const ask = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  })
  return {
    hooks: [
      async (input) => {
        const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
        const toolInput = asRecord(input.tool_input)
        const call: AskCall = {
          cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined,
          commands: new Map(),
        }
        let rule: string | undefined
        try {
          rule = rules.find((candidate) => askRuleCovers(candidate, tool, toolInput, cwd, call))
        } catch {
          // The CLI lets a call through when this callback fails: ask.
          return ask(
            'Your Claude Code settings ask before some calls, and this one could not be checked against them.',
          )
        }
        return rule ? ask(`Your Claude Code settings ask before ${rule}.`) : {}
      },
    ],
  }
}

// Whether a permission rule (`Tool` or `Tool(specifier)`) covers a call.
export function askRuleCovers(
  rule: string,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  call: AskCall = {},
): boolean {
  const match = /^([^(]+?)\s*(?:\(([\s\S]*)\))?$/.exec(rule.trim())
  if (!match?.[1]) return false
  const name = match[1]
  const specifier = match[2]?.trim() ?? ''
  if (name.startsWith('mcp__') && !name.includes('*')) return mcpRuleCovers(name, tool)
  const called = canonicalTool(tool)
  // Monitor runs its command as the Bash tool does, under the Bash rules.
  const command = typeof input.command === 'string' ? input.command : null
  const asBash = name === 'Bash' && called === 'Monitor' && command !== null
  if (!asBash && !toolsMatch(name, tool)) return false
  if (specifier === '' || specifier === '*') return true
  if (called === 'Bash' || asBash) return bashRuleCovers(specifier, command ?? '', call.commands)
  if (EDIT_TOOLS.includes(called) || READ_TOOLS.includes(called)) {
    const folders = [...new Set([call.cwd ?? cwd, cwd])]
    return pathRuleCovers(specifier, toolPaths(called, input, folders), cwd)
  }
  if (called === 'WebFetch') return domainRuleCovers(specifier, stringOf(input.url))
  // A call that names no subagent runs the general-purpose one.
  if (called === 'Agent') {
    const type = stringOf(input.subagent_type).trim() || 'general-purpose'
    return type.toLowerCase() === specifier.toLowerCase()
  }
  // A specifier this does not know how to read: ask.
  return true
}

function canonicalTool(name: string): string {
  return Object.hasOwn(RENAMED, name) ? (RENAMED[name] ?? name) : name
}

function toolsMatch(name: string, tool: string): boolean {
  const rule = canonicalTool(name)
  const called = canonicalTool(tool)
  // Claude Code's ask and deny rules take * in a tool name.
  if (rule.includes('*')) {
    const pattern = (rule.startsWith('mcp__') ? cleanMcpName(rule) : rule).replaceAll('*', UNKNOWN)
    return mayMatch(called, pattern) || mayMatch(tool, pattern)
  }
  if (rule === called) return true
  // An edit rule covers every tool that edits files; a Read rule every
  // tool that reads them.
  if (EDIT_TOOLS.includes(rule)) return EDIT_TOOLS.includes(called)
  if (rule === 'Read') return READ_TOOLS.includes(called)
  return false
}

// mcp__server covers the server's tools, and only that server's: Claude
// Code matches a rule's server name exactly (mcp__server__* is a wildcard
// rule, see toolsMatch). A server name may hold `__` itself, so mcp__a__b,
// server a's tool b, also covers the tools of a server a__b, as Claude
// Code's ask rules do.
function mcpRuleCovers(name: string, tool: string): boolean {
  const rule = cleanMcpName(name)
  return tool === rule || tool.startsWith(`${rule}__`)
}

function cleanMcpName(text: string): string {
  return text.replace(/[^A-Za-z0-9_*-]/g, '_')
}

// Bash(specifier): `prefix:*`, a pattern with * wildcards, or a command.
// The specifier is read with its quotes removed, so its quoting does not
// have to match the command's; on macOS and Windows, which find a command
// whatever its case, the command name matches in any case. `parsed` keeps
// each command line's commands for the next rule.
export function bashRuleCovers(
  specifier: string,
  line: string,
  parsed?: Map<string, readonly string[] | null>,
): boolean {
  let commands = parsed?.get(line)
  if (commands === undefined) {
    commands = commandCandidates(line)
    parsed?.set(line, commands)
  }
  // Cannot tell the commands apart: ask.
  if (commands === null) return true
  const patterns = bashPatterns(specifier)
  return commands.some((command) => patterns.some((pattern) => mayMatch(command, pattern)))
}

// The commands a Bash rule covers, as text with UNKNOWN for its wildcards.
function bashPatterns(specifier: string): string[] {
  const text = ruleWords(specifier) ?? specifier.trim().replaceAll('*', UNKNOWN)
  const forms = [text]
  if (COMMAND_NAMES_IGNORE_CASE) {
    const name = text.split(' ', 1)[0] ?? ''
    forms.push(name.toLowerCase() + text.slice(name.length))
  }
  const tail = ` ${UNKNOWN}`
  const patterns = forms.flatMap((form) => {
    // Legacy prefix form.
    if (form.endsWith(`:${UNKNOWN}`)) {
      const prefix = form.slice(0, -2).trimEnd()
      return [prefix, prefix + tail]
    }
    // `cmd *` also covers `cmd` alone.
    if (form.endsWith(tail)) return [form, form.slice(0, -tail.length)]
    if (form.includes(UNKNOWN)) return [form]
    // A plain command, with or without more arguments.
    return [form, form + tail]
  })
  return [...new Set(patterns)]
}

// A rule's words with quotes removed, joined by single spaces, * as
// UNKNOWN; null for an unterminated quote.
function ruleWords(specifier: string): string | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  for (let index = 0; index < specifier.length; index += 1) {
    const char = specifier[index] ?? ''
    if (char === '\\' && index + 1 < specifier.length) {
      word += specifier[index + 1]
      inWord = true
      index += 1
    } else if (char === "'" || char === '"') {
      const close = specifier.indexOf(char, index + 1)
      if (close < 0) return null
      word += specifier.slice(index + 1, close)
      inWord = true
      index = close
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += char
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words.join(' ').replaceAll('*', UNKNOWN)
}

// The files a file tool works on, or the folders a search tool looks in, as
// absolute paths before .. is worked out; null when the call names none it
// should. A relative path may start from any of `folders`.
function toolPaths(
  tool: string,
  input: Record<string, unknown>,
  folders: string[],
): string[] | null {
  // Every path the input holds, the tool's own among them.
  const raws = [input.file_path, input.notebook_path, input.path].map(stringOf).filter(Boolean)
  if (raws.length === 0 && !SEARCH_TOOLS.includes(tool)) return null
  const names = [...new Set(raws.flatMap((raw) => [raw, raw.trim()]))]
  const roots =
    names.length === 0
      ? folders
      : names.flatMap((name) => folders.map((folder) => absolutePath(name, folder)))
  // A glob reaches below its fixed leading folders, which may lie outside
  // the folder searched (an absolute pattern, ~ or ..).
  const glob =
    tool === 'Glob' ? stringOf(input.pattern) : tool === 'Grep' ? stringOf(input.glob) : ''
  const bases = glob ? roots.map((root) => absolutePath(globBase(glob), root)) : []
  return [...roots, ...bases]
}

function absolutePath(path: string, folder: string): string {
  if (path === '~' || path.startsWith('~/')) return homedir() + path.slice(1)
  return isAbsolute(path) ? path : `${folder}/${path}`
}

// The part of a glob before its first wildcard: the folder it lists, or
// the file it names. A brace list there ({secrets,docs}/*) stops it too, so
// such a glob is checked by the folder it searches, as Claude Code checks a
// search.
function globBase(glob: string): string {
  const parts = glob.split('/')
  const first = parts.findIndex((part) => /[*?[{]/.test(part))
  if (first < 0) return glob
  return parts.slice(0, first).join('/') || (glob.startsWith('/') ? '/' : '.')
}

// A file rule: //absolute, ~/home, /from-the-project or relative to the
// thread's folder, in gitignore pattern syntax; it covers what is inside a
// folder it names too. A path matches through symlinks, with .. after a
// symlink taken as the file system takes it, and without regard to case.
export function pathRuleCovers(
  specifier: string,
  targets: readonly string[] | null,
  cwd: string,
): boolean {
  if (targets === null || targets.some((target) => target.length > MAX_PATH)) return true
  const globs = pathPatterns(specifier, cwd).map(compileGlob)
  const paths = new Set(
    targets.flatMap((target) => {
      const lexical = resolve(target)
      return [lexical, physicalPath(target), physicalPath(lexical)].map(fold)
    }),
  )
  return [...paths].some((path) => globs.some((glob) => globMatches(glob, path)))
}

function pathPatterns(specifier: string, cwd: string): string[] {
  const patterns: string[] = []
  if (specifier.startsWith('//')) patterns.push(join('/', specifier.slice(2)))
  else if (specifier === '~' || specifier.startsWith('~/'))
    patterns.push(join(homedir(), specifier.slice(1)))
  else
    for (const root of new Set([resolve(cwd), physicalPath(cwd)])) {
      const relative = specifier.replace(/^\.?\//, '')
      patterns.push(join(root, relative))
      // A pattern without a slash matches at any depth, as in .gitignore.
      if (!relative.replace(/\/+$/, '').includes('/')) patterns.push(join(root, '**', relative))
    }
  return [...new Set(patterns.flatMap((pattern) => [pattern, physicalPath(pattern)]))]
}

// A path pattern as steps: one character, * (text without a slash), **
// (any text) or **/ (nothing, or text ending in a slash).
type GlobStep =
  | { readonly kind: 'char'; readonly test: (char: string) => boolean }
  | { readonly kind: 'name' | 'any' | 'folders' }

// A trailing /** covers the folder itself as well, as a match covers what
// is inside it.
function compileGlob(glob: string): GlobStep[] {
  const folded = fold(glob)
  const pattern = (folded.endsWith('/**') ? folded.slice(0, -3) : folded).replace(/\/$/, '')
  const steps: GlobStep[] = []
  const literal = (expected: string): GlobStep => ({ kind: 'char', test: (c) => c === expected })
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '\\' && index + 1 < pattern.length) {
      steps.push(literal(pattern[index + 1] ?? ''))
      index += 1
    } else if (char === '*' && pattern[index + 1] === '*') {
      const folders = pattern[index + 2] === '/'
      steps.push({ kind: folders ? 'folders' : 'any' })
      index += folders ? 2 : 1
    } else if (char === '*') steps.push({ kind: 'name' })
    else if (char === '?') steps.push({ kind: 'char', test: (c) => c !== '/' })
    else if (char === '[' && pattern.indexOf(']', index + 2) > 0) {
      // A set of characters, [!...] or [^...] for those not in it.
      const close = pattern.indexOf(']', index + 2)
      let set = pattern.slice(index + 1, close)
      const negated = set.startsWith('!') || set.startsWith('^')
      if (negated) set = set.slice(1)
      steps.push({ kind: 'char', test: (c) => c !== '/' && inSet(set, c) !== negated })
      index = close
    } else steps.push(literal(char))
  }
  return steps
}

function inSet(set: string, char: string): boolean {
  for (let index = 0; index < set.length; index += 1) {
    const low = set[index] ?? ''
    if (set[index + 1] === '-' && index + 2 < set.length) {
      const high = set[index + 2] ?? ''
      if (char >= low && char <= high) return true
      index += 2
    } else if (char === low) return true
  }
  return false
}

// Whether a path fits a pattern, or lies inside a folder that does, read
// in one pass over the path for all the ways the pattern can match.
function globMatches(steps: readonly GlobStep[], path: string): boolean {
  const done = steps.length
  const inside = steps.length + 1
  // A **/ that has taken text but not yet its closing slash.
  const midway = (step: number) => steps.length + 2 + step
  const closure = (states: Set<number>): Set<number> => {
    for (const state of states) {
      const kind = steps[state]?.kind
      if (kind === 'name' || kind === 'any' || kind === 'folders') states.add(state + 1)
    }
    return states
  }
  let states = closure(new Set([0]))
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index] ?? ''
    const next = new Set<number>()
    for (const state of states) {
      if (state === inside) next.add(inside)
      else if (state === done) {
        if (char === '/') next.add(inside)
      } else if (state > inside) {
        const step = state - steps.length - 2
        next.add(state)
        if (char === '/') next.add(step + 1)
      } else {
        const step = steps[state]
        if (!step) continue
        if (step.kind === 'char') {
          if (step.test(char)) next.add(state + 1)
        } else if (step.kind === 'name') {
          if (char !== '/') next.add(state)
        } else if (step.kind === 'any') next.add(state)
        else {
          next.add(midway(state))
          if (char === '/') next.add(state + 1)
        }
      }
    }
    states = closure(next)
    if (states.size === 0) return false
  }
  return states.has(done) || states.has(inside)
}

// WebFetch(domain:example.com) covers the host and its subdomains;
// domain:*.example.com, domain:* and other * patterns the hosts they fit.
function domainRuleCovers(specifier: string, url: string): boolean {
  if (!specifier.startsWith('domain:')) return true
  const domain = ruleDomain(specifier.slice('domain:'.length))
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return true
  }
  if (host === '' || domain === '') return true
  if (!domain.includes('*')) return host === domain || host.endsWith(`.${domain}`)
  const parent = domain.startsWith('*.') ? domain.slice(2) : ''
  if (parent && !parent.includes('*') && (host === parent || host.endsWith(`.${parent}`)))
    return true
  return mayMatch(host, domain.replaceAll('*', UNKNOWN))
}

// A rule's domain as a URL's host reads: lowercase, punycode, no port and
// no trailing dot.
function ruleDomain(text: string): string {
  const lower = text.trim().toLowerCase()
  const bare = lower.startsWith('[')
    ? lower.replace(/\](?::\d+)?$/, ']')
    : lower.replace(/:\d+$/, '')
  return bare
    .replace(/\.+$/, '')
    .split('.')
    .map((label) => (label.includes('*') ? label : domainToASCII(label) || label))
    .join('.')
}

// Paths compare as Claude Code compares them: without regard to case or
// Unicode normalization (APFS ignores both).
function fold(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

// The path the file system reaches, symlinks and .. followed in order, for
// a file that may not exist yet.
function physicalPath(path: string): string {
  const missing: string[] = []
  for (let head = path; ; ) {
    try {
      return join(realpathSync.native(head), ...missing.reverse())
    } catch {
      const parent = dirname(head)
      if (parent === head) return join(head, ...missing.reverse())
      missing.push(basename(head))
      head = parent
    }
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
