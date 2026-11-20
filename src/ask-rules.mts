import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { domainToASCII } from 'node:url'
import type { HookMatcher } from './sdk-hooks.mjs'
import { commandCandidates, UNKNOWN } from './shell-commands.mjs'

// The ask rules of the user's Claude Code settings (permissions.ask). The
// CLI takes no ask rules outside a settings file, so a PreToolUse callback
// stands in for them: a call a rule covers gets the 'ask' decision, which
// sends it to the permission prompt (the Codex approval) even when an allow
// rule or a hook would have let it run. Rules are matched as Claude Code
// matches them, erring towards asking: a Bash rule covers each command of
// a compound command line and what a wrapper such as `timeout` or `sh -c`
// runs, a word the shell expands could be any text, and a command line
// whose commands cannot be told apart (command substitution, a heredoc, a
// shell reading its commands from stdin) is asked about under any Bash
// rule, since it could run anything (see shell-commands.mts). File rules
// match paths without regard to case, as Claude Code does, and through
// symlinks.

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

// The PreToolUse matcher that asks before the calls `rules` cover. `cwd` is
// the thread's folder: a rule's relative paths start from it, as they do
// for the rules the CLI takes on its command line. A call's relative paths
// start from the session's folder at the time, and from the thread's too.
export function askRulesGuard(rules: readonly string[], cwd: string): HookMatcher {
  return {
    hooks: [
      async (input) => {
        const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
        const toolInput = asRecord(input.tool_input)
        const callCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
        const rule = rules.find((candidate) =>
          askRuleCovers(candidate, tool, toolInput, cwd, callCwd),
        )
        if (!rule) return {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `Your Claude Code settings ask before ${rule}.`,
          },
        }
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
  callCwd?: string,
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
  if (called === 'Bash' || asBash) return bashRuleCovers(specifier, command ?? '')
  if (EDIT_TOOLS.includes(called) || READ_TOOLS.includes(called)) {
    const folders = [...new Set([callCwd ?? cwd, cwd])]
    return pathRuleCovers(specifier, toolPaths(called, input, folders), cwd)
  }
  if (called === 'WebFetch') return domainRuleCovers(specifier, stringOf(input.url))
  // A call that names no subagent runs the default one.
  if (called === 'Agent') {
    const type = stringOf(input.subagent_type).trim().toLowerCase()
    return type === '' || type === specifier.toLowerCase()
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
    const pattern = wildcardExpression(rule.startsWith('mcp__') ? cleanMcpName(rule) : rule)
    return pattern.test(called) || pattern.test(tool)
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
// have to match the command's, and like a command name without regard to
// case.
export function bashRuleCovers(specifier: string, line: string): boolean {
  const commands = commandCandidates(line)
  // Cannot tell the commands apart: ask.
  if (commands === null) return true
  const patterns = bashPatterns(specifier)
  return commands.some((command) => patterns.some((pattern) => mayMatch(command, pattern)))
}

// The commands a Bash rule covers, as text with UNKNOWN for its wildcards.
function bashPatterns(specifier: string): string[] {
  const text = (ruleWords(specifier) ?? specifier.trim().replaceAll('*', UNKNOWN)).toLowerCase()
  const tail = ` ${UNKNOWN}`
  // Legacy prefix form.
  if (text.endsWith(`:${UNKNOWN}`)) {
    const prefix = text.slice(0, -2).trimEnd()
    return [prefix, prefix + tail]
  }
  // `cmd *` also covers `cmd` alone.
  if (text.endsWith(tail)) return [text, text.slice(0, -tail.length)]
  if (text.includes(UNKNOWN)) return [text]
  // A plain command, with or without more arguments.
  return [text, text + tail]
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

// Whether some text fits both `a` and `b`, where UNKNOWN in either stands
// for any text.
function mayMatch(a: string, b: string): boolean {
  // The common literal start and end first; most pairs part there.
  let start = 0
  while (start < a.length && start < b.length && a[start] !== UNKNOWN && b[start] !== UNKNOWN) {
    if (a[start] !== b[start]) return false
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] !== UNKNOWN && b[endB - 1] !== UNKNOWN) {
    if (a[endA - 1] !== b[endB - 1]) return false
    endA -= 1
    endB -= 1
  }
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  if (x === UNKNOWN || y === UNKNOWN) return true
  // Too long to compare: ask.
  if (x.length * y.length > 4_000_000) return true
  // fits[j]: whether x from i on and y from j on fit some text, row by row
  // from the end.
  let next = new Uint8Array(y.length + 1)
  let row = new Uint8Array(y.length + 1)
  next[y.length] = 1
  for (let j = y.length - 1; j >= 0; j -= 1) next[j] = y[j] === UNKNOWN && next[j + 1] ? 1 : 0
  for (let i = x.length - 1; i >= 0; i -= 1) {
    row[y.length] = x[i] === UNKNOWN && next[y.length] ? 1 : 0
    for (let j = y.length - 1; j >= 0; j -= 1) {
      if (x[i] === UNKNOWN) row[j] = next[j] || row[j + 1] ? 1 : 0
      else if (y[j] === UNKNOWN) row[j] = row[j + 1] || next[j] ? 1 : 0
      else row[j] = x[i] === y[j] && next[j + 1] ? 1 : 0
    }
    ;[next, row] = [row, next]
  }
  return next[0] === 1
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
// the file it names.
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
  if (targets === null) return true
  const expressions = pathPatterns(specifier, cwd).map(globExpression)
  const paths = new Set(
    targets.flatMap((target) => {
      const lexical = resolve(target)
      return [lexical, physicalPath(target), physicalPath(lexical)].map(fold)
    }),
  )
  return [...paths].some((path) => expressions.some((expression) => expression.test(path)))
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

// A trailing /** covers the folder itself as well.
function globExpression(glob: string): RegExp {
  const folded = fold(glob)
  const pattern = folded.endsWith('/**') ? folded.slice(0, -3) : folded
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '\\' && index + 1 < pattern.length) {
      source += escapeRegExp(pattern[index + 1] ?? '')
      index += 1
    } else if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[' && pattern.indexOf(']', index + 2) > 0) {
      // A set of characters, [!...] or [^...] for those not in it.
      const close = pattern.indexOf(']', index + 2)
      let set = pattern.slice(index + 1, close)
      const negated = set.startsWith('!') || set.startsWith('^')
      if (negated) set = set.slice(1)
      source += `(?!/)[${negated ? '^' : ''}${set.replace(/[\\\]^]/g, '\\$&')}]`
      index = close
    } else source += escapeRegExp(char)
  }
  try {
    return new RegExp(`^${source.replace(/\/$/, '')}(?:/.*)?$`, 's')
  } catch {
    // A pattern this cannot read: it covers everything.
    return /(?:)/
  }
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
  return wildcardExpression(domain).test(host)
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

function wildcardExpression(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 's')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Paths compare as Claude Code compares them: without regard to case or
// Unicode normalization (APFS ignores both).
function fold(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

// The path the file system reaches, symlinks and .. followed in order, for
// a file that may not exist yet.
function physicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(physicalPath(parent), basename(path))
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
