// The commands a shell command line can run, for matching Bash permission
// rules against it (see ask-rules.mts). The line is read the way bash and
// zsh read it (Claude Code runs it in the user's shell), and wherever the
// reading is unsure it takes every way the line could go: each command of a
// compound line, what a wrapper such as `sudo`, `timeout`, `xargs` or
// `find -exec` runs whichever of its options takes a value, the script a
// shell runs with -c, eval or trap. A word the shell works out when it runs
// ($VAR, a glob, a brace list) stands for any text. A line whose commands
// only the shell can tell (command substitution, a heredoc, a shell reading
// its commands from stdin, a zsh glob in a command name) has none: the
// caller treats it as running anything.

// Text only the shell knows: any text, spaces included. A command line
// never holds this character (the shell cannot pass it on).
export const UNKNOWN = '\u0000'

// Every command a command line may run, each as its words joined by single
// spaces and lowercased (macOS finds `GIT` as git), with a program named by
// a path also under its file name; null when that cannot be told.
export function commandCandidates(line: string): string[] | null {
  const out = new Candidates()
  if (!collect(line, 0, out)) return null
  // The whole line too, for a rule naming a compound command.
  out.addText(line.trim().replace(/\s+/g, ' '))
  return out.overflow ? null : [...out.texts]
}

interface Word {
  // The word as the program gets it, with UNKNOWN for what the shell expands.
  readonly text: string
  // Unquoted and unexpanded, so it may be a reserved word such as `if`.
  readonly plain: boolean
  // A variable assignment (NAME=value) before a command; maybe when its
  // subscript holds quotes or expansions.
  readonly assignment: 'yes' | 'no' | 'maybe'
}

interface Part {
  readonly text: string
  readonly quoted: boolean
}

const MAX_DEPTH = 4
const MAX_CANDIDATES = 2000
const MAX_CHARS = 200_000

// Reserved words that may come before a command.
const RESERVED = new Set([
  '!',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'if',
  'then',
  'until',
  'while',
])

// Commands that run the rest of their command line: `values` are the
// options that take the next word, `operands` the words between the options
// and the command (a duration, a file). An option not listed may or may not
// take the next word, so both readings count.
interface Runner {
  readonly values?: readonly string[]
  readonly operands?: number
}
const options = (...lists: string[]): string[] => lists.join(' ').split(' ')
const RUNNERS: Record<string, Runner> = {
  // zsh's precommand modifier.
  '-': {},
  arch: { values: options('-arch -d -e') },
  builtin: {},
  busybox: {},
  caffeinate: { values: options('-t -w') },
  chroot: { values: options('-u -g -G --userspec --groups'), operands: 1 },
  chrt: {
    values: options('-T -P -D --sched-runtime --sched-period --sched-deadline'),
    operands: 1,
  },
  command: {},
  coproc: { operands: 1 },
  doas: { values: options('-a -u -C') },
  env: { values: options('-u -C -P -S --unset --chdir --split-string') },
  exec: { values: options('-a') },
  flock: { values: options('-w -E --timeout --wait --conflict-exit-code'), operands: 1 },
  // `function name body` in zsh.
  function: { operands: 1 },
  ionice: {
    values: options('-c -n -p -P -u --class --classdata --pid --pgid --uid'),
  },
  ltrace: {
    values: options('-a -A -e -l -n -o -p -s -u -x -D -F -w --output'),
  },
  nice: { values: options('-n --adjustment') },
  nocorrect: {},
  noglob: {},
  nohup: {},
  nsenter: { values: options('-t -S -G --target --setuid --setgid') },
  parallel: {
    values: options(
      '-a -d -E -I -j -L -n -N -P -S',
      '--arg-file --colsep --delimiter --jobs --joblog --results --sshlogin --tmpdir',
    ),
  },
  pkexec: { values: options('--user') },
  repeat: { operands: 1 },
  script: {
    values: options(
      '-B -E -I -m -o -O -T',
      '--log-in --log-io --log-out --log-timing --logging-format --output-limit',
    ),
    operands: 1,
  },
  setsid: {},
  stdbuf: { values: options('-i -o -e --input --output --error') },
  strace: {
    values: options(
      '-a -b -e -E -I -o -O -p -P -s -S -u -U -X',
      '--output --trace --expr --attach --env --trace-path --user',
    ),
  },
  sudo: {
    values: options(
      '-a -C -D -g -p -r -R -t -T -u -U --auth-type --chdir --chroot --close-from',
      '--command-timeout --group --host --other-user --prompt --role --type --user',
    ),
  },
  taskset: { operands: 1 },
  time: { values: options('-f -o --format --output') },
  timeout: { values: options('-k -s --kill-after --signal'), operands: 1 },
  toybox: {},
  unbuffer: {},
  unshare: {
    values: options('-R -w -S -G --setuid --setgid --root --wd --propagation --setgroups'),
  },
  watch: { values: options('-n --interval --equexit') },
  xargs: {
    values: options(
      '-a -d -E -I -J -L -n -P -R -s -S',
      '--arg-file --delimiter --max-args --max-chars --max-procs --process-slot-var',
    ),
  },
}
// Shells whose options this reads exactly; the others' -c takes any word
// after it as the script.
const SH = new Set(['ash', 'bash', 'dash', 'sh', 'zsh'])
const SHELLS = new Set([...SH, 'csh', 'fish', 'ksh', 'mksh', 'posh', 'tcsh', 'yash'])
// find and fd run what follows these options, with {} standing for a path.
const EXEC_OPTIONS: Record<string, readonly string[]> = {
  fd: ['-x', '-X', '--exec', '--exec-batch'],
  find: ['-exec', '-execdir', '-ok', '-okdir'],
}

class Candidates {
  readonly texts = new Set<string>()
  overflow = false
  private chars = 0

  // A command and its arguments, under each name its program goes by.
  add(words: readonly Word[]): boolean {
    const [program = '', ...rest] = words.map((word) => word.text)
    // zsh runs `=git` as the git on the PATH.
    const names = new Set([program, program.length > 1 ? program.replace(/^=/, '') : program])
    for (const name of [...names]) names.add(baseName(name))
    for (const name of names) this.addText([name, ...rest].join(' '))
    return !this.overflow
  }

  addText(text: string): void {
    const lower = text.toLowerCase()
    if (this.texts.has(lower)) return
    this.chars += lower.length
    if (this.texts.size >= MAX_CANDIDATES || this.chars > MAX_CHARS) this.overflow = true
    else this.texts.add(lower)
  }
}

function collect(line: string, depth: number, out: Candidates): boolean {
  if (depth > MAX_DEPTH) return false
  const commands = parseLine(line)
  if (commands === null) return false
  return commands.every((words) => analyze(words, depth, out))
}

// The commands of one simple command: its own, and those its wrappers run.
function analyze(words: readonly Word[], depth: number, out: Candidates): boolean {
  const starts = new Set([0])
  for (let index = 0; index < words.length; index += 1) {
    if (!starts.has(index)) continue
    const word = words[index] as Word
    if ((word.plain && RESERVED.has(word.text)) || word.assignment === 'yes') {
      starts.add(index + 1)
      continue
    }
    if (word.assignment === 'maybe') starts.add(index + 1)
    if (!out.add(words.slice(index))) return false
    const more = runs(words, index, depth, out)
    if (more === null) return false
    for (const start of more) starts.add(start)
  }
  return true
}

// Where the commands that the command at `index` runs start, after adding
// those it runs from text (a shell's -c script, eval) to `out`; null when
// what it runs cannot be told.
function runs(
  words: readonly Word[],
  index: number,
  depth: number,
  out: Candidates,
): number[] | null {
  const name = programName(words[index]?.text ?? '')
  const args = words.slice(index + 1).map((word) => word.text)
  const reparse = (text: string) => collect(text, depth + 1, out)
  const shell = name.replace(/[-\d.]+$/, '')
  if (SHELLS.has(shell)) return shellRuns(shell, args, reparse) ? [] : null
  if (name === 'su' || name === 'runuser') return suRuns(args, reparse) ? [] : null
  if (name === 'pwsh' || name === 'powershell') {
    // Its -Command script is PowerShell, which this does not read.
    if (args.some((arg) => /^-(?:c|command|e|ec|encodedcommand)$/i.test(arg))) return null
    return args.some((arg) => !arg.startsWith('-')) ? [] : null
  }
  if (name === 'eval') return reparse(args.join(' ')) ? [] : null
  if (name === 'trap') {
    const action = args.find((arg) => !/^-[-lp]*$/.test(arg))
    return action === undefined || action === '-' || reparse(action) ? [] : null
  }
  // An alias runs its text in place of a later command: unknown.
  if (name === 'alias') return args.some((arg) => arg.includes('=')) ? null : []
  const exec = Object.hasOwn(EXEC_OPTIONS, name) ? EXEC_OPTIONS[name] : undefined
  if (exec) {
    for (let at = 0; at < args.length; at += 1) {
      if (!exec.includes(args[at] ?? '')) continue
      let end = args.length
      if (name === 'find')
        for (let stop = at + 1; stop < args.length; stop += 1)
          if (args[stop] === ';' || (args[stop] === '+' && args[stop - 1]?.includes('{}'))) {
            end = stop
            break
          }
      const command = words.slice(index + 2 + at, index + 1 + end)
      const placeholder = (text: string) => /\{[/.]*\}/.test(text)
      if (!analyze(substituted(command, placeholder, name === 'fd'), depth, out)) return null
    }
    return []
  }
  const runner = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined
  if (!runner) return []
  // command -v and -V only say what a name is.
  if (name === 'command' && leadingOptions(args).some((arg) => /^-[a-zA-Z]*[vV]/.test(arg)))
    return []
  const starts = commandStarts(words, index, runner)
  if (name === 'xargs' || name === 'parallel') {
    // They add arguments from their input, or put them in place of the
    // replacement string.
    const replace = new Set(['{}'])
    for (const [at, arg] of args.entries()) {
      if (arg === '-I' || arg === '-J') replace.add(args[at + 1] ?? '{}')
      const attached = /^(?:-[IJi]|--replace=)(.+)$/.exec(arg)
      if (attached?.[1]) replace.add(attached[1])
    }
    const placeholder = (text: string) => [...replace].some((value) => text.includes(value))
    for (const start of starts)
      if (!analyze(substituted(words.slice(start), placeholder, true), depth, out)) return null
    return []
  }
  if (name === 'watch') {
    // It runs its arguments, joined, with sh -c.
    for (const start of starts) {
      const text = words.slice(start).map((word) => word.text)
      if (!reparse(text.join(' '))) return null
    }
    return []
  }
  if (name === 'env') {
    // env -S splits its value into the command and its arguments.
    const split = leadingOptions(args).findIndex((arg) =>
      /^(?:-[a-zA-Z]*S|--split-string)/.test(arg),
    )
    if (split >= 0) {
      const arg = args[split] ?? ''
      const attached = /^(?:-[a-zA-Z]*S|--split-string=?)(.*)$/.exec(arg)?.[1] ?? ''
      if (!reparse([attached, ...args.slice(split + 1)].join(' '))) return null
    }
  }
  if ((name === 'flock' || name === 'script') && !commandOption(args, reparse)) return null
  // sudo -s or -i with no command is a shell reading its commands from stdin.
  if (
    name === 'sudo' &&
    args.some((arg) => ['-i', '-s', '--login', '--shell'].includes(arg)) &&
    starts.every((start) => start >= words.length)
  )
    return null
  return starts
}

// The arguments up to the first that is not an option (any word may be an
// option's value).
function leadingOptions(args: readonly string[]): readonly string[] {
  const end = args.findIndex((arg, at) => !arg.startsWith('-') && !args[at - 1]?.startsWith('-'))
  return end < 0 ? args : args.slice(0, end)
}

// The words where a wrapper's command may start.
function commandStarts(words: readonly Word[], index: number, runner: Runner): number[] {
  const values = runner.values ?? []
  const found = new Set<number>()
  const seen = new Set<number>()
  const after = (at: number): void => {
    for (let skip = 0; skip <= (runner.operands ?? 0); skip += 1)
      if (at + skip < words.length) found.add(at + skip)
  }
  const visit = (at: number): void => {
    if (at >= words.length || seen.has(at)) return
    seen.add(at)
    const text = words[at]?.text ?? ''
    const attached = text.startsWith('--')
      ? text.includes('=')
      : values.some((value) => !value.startsWith('--') && text.startsWith(value))
    if (text === '--') after(at + 1)
    else if (!text.startsWith('-')) after(at)
    else if (values.includes(text)) visit(at + 2)
    else if (attached) visit(at + 1)
    else {
      // An option this does not know: it may take the next word or not.
      visit(at + 1)
      visit(at + 2)
    }
  }
  visit(index + 1)
  return [...found]
}

// A shell's -c script. bash, sh and zsh take their options up to the first
// other word, -o and -O with a value, and that word is the script. A shell
// with no -c and no script file reads its commands from stdin: unknown.
function shellRuns(
  shell: string,
  args: readonly string[],
  reparse: (text: string) => boolean,
): boolean {
  let script = false
  let stdin = false
  let info = false
  let exact = SH.has(shell)
  let at = 0
  for (; at < args.length; at += 1) {
    const arg = args[at] ?? ''
    if (arg === '--' || arg === '-') {
      at += 1
      break
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      const letters = arg.slice(1)
      if (arg.startsWith('-') && letters.includes('c')) script = true
      if (arg.startsWith('-') && letters.includes('s')) stdin = true
      const value = letters.search(/[oO]/)
      if (value >= 0) {
        // -o or -O amid other letters: which word is its value is unsure.
        if (value !== letters.length - 1) exact = false
        at += 1
      }
      if (shell === 'fish' && letters.includes('C')) script = true
      continue
    }
    if (arg.startsWith('--')) {
      if (arg === '--command' || arg === '--init-command') script = true
      else if (/^--(?:init-)?command=/.test(arg)) {
        if (!reparse(arg.slice(arg.indexOf('=') + 1))) return false
      } else if (['--rcfile', '--init-file', '--emulate'].includes(arg)) at += 1
      else if (arg === '--version' || arg === '--help') info = true
      continue
    }
    break
  }
  if (script) {
    if (exact) return at >= args.length || reparse(args[at] ?? '')
    // Any word after the -c may be the script.
    const first = args.findIndex((arg) => /^-[A-Za-z]*[cC]/.test(arg) || arg.startsWith('--'))
    return args.slice(first + 1).every((arg) => reparse(arg))
  }
  return info || (at < args.length && !stdin)
}

// su and runuser run their -c command with the user's shell; without one
// the shell reads its commands from stdin.
function suRuns(args: readonly string[], reparse: (text: string) => boolean): boolean {
  return commandOption(args, reparse) && args.some((arg) => /^(?:-[a-zA-Z]*c|--command)/.test(arg))
}

// The -c / --command option's command, for su, flock and script.
function commandOption(args: readonly string[], reparse: (text: string) => boolean): boolean {
  for (const [at, arg] of args.entries()) {
    if (arg === '-c' || arg === '--command' || /^-[a-zA-Z]+c$/.test(arg)) {
      if (!reparse(args[at + 1] ?? '')) return false
    } else if (/^--command=/.test(arg)) {
      if (!reparse(arg.slice('--command='.length))) return false
    } else if (/^-c./.test(arg) && !reparse(arg.slice(2))) return false
  }
  return true
}

// Words with what xargs or find put in place of a placeholder unknown, and
// for xargs the arguments it adds at the end.
function substituted(
  words: readonly Word[],
  placeholder: (text: string) => boolean,
  appends: boolean,
): Word[] {
  const out = words.map((word) => (placeholder(word.text) ? unknownWord() : word))
  if (appends) out.push(unknownWord())
  return out
}

function unknownWord(): Word {
  return { text: UNKNOWN, plain: false, assignment: 'no' }
}

// The program's file name, lowercased.
function programName(text: string): string {
  return baseName(text.length > 1 ? text.replace(/^=/, '') : text).toLowerCase()
}

// The last part of a path. Unknown text may hold a slash, so the name may
// start anywhere in it.
function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const unknown = name.lastIndexOf(UNKNOWN)
  return unknown < 0 ? name : UNKNOWN + name.slice(unknown + 1)
}

// The simple commands of a command line as their words, with quotes
// removed and redirections dropped; null for what only the shell can tell.
function parseLine(line: string): Word[][] | null {
  if (line.includes(UNKNOWN)) return null
  const commands: Word[][] = []
  let words: Word[] = []
  let parts: Part[] = []
  let skipNext = false
  let unknown = false
  const add = (text: string, quoted: boolean): void => {
    const last = parts.at(-1)
    if (last && last.quoted === quoted) parts[parts.length - 1] = { text: last.text + text, quoted }
    else parts.push({ text, quoted })
  }
  const endCommand = (): void => {
    if (words.length > 0) commands.push(words)
    words = []
  }
  const endWord = (): void => {
    if (parts.length === 0) return
    // bash and zsh run a command substitution in an array subscript that
    // a builtin evaluates, quoted or not (`printf -v 'a[$(cmd)]' x`).
    const raw = parts.map((part) => part.text).join('')
    const subscript = raw.indexOf('[')
    if (subscript >= 0 && /\$\(|`/.test(raw.slice(subscript))) unknown = true
    const word = wordOf(parts)
    parts = []
    if (skipNext) {
      skipNext = false
      return
    }
    // { and } open and close a group, and zsh takes a command right after
    // a test's ]] (`if [[ -n $x ]] git push`).
    if (word.plain && (word.text === '{' || word.text === '}')) {
      endCommand()
      return
    }
    words.push(word)
    if (word.plain && word.text === ']]') endCommand()
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? ''
    const next = line[index + 1] ?? ''
    if (char === '\\') {
      // A backslash before a newline joins the lines.
      if (next !== '\n') add(next || '\\', true)
      index += 1
      continue
    }
    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      if (close < 0) return null
      add(line.slice(index + 1, close), true)
      index = close
      continue
    }
    if (char === '$' && next === "'") {
      const ansi = ansiCString(line, index + 2)
      if (ansi === null) return null
      add(ansi.text, true)
      index = ansi.end
      continue
    }
    if (char === '"' || (char === '$' && next === '"')) {
      const quoted = doubleQuoted(line, index + (char === '"' ? 1 : 2))
      if (quoted === null) return null
      add(quoted.text, true)
      index = quoted.end
      continue
    }
    if (char === '`') return null
    if (char === '$') {
      const end = expansionEnd(line, index)
      if (end === null) return null
      if (end === index + 1) add('$', false)
      else add(UNKNOWN, true)
      index = end - 1
      continue
    }
    if (char === '#' && parts.length === 0) {
      const newline = line.indexOf('\n', index)
      if (newline < 0) break
      index = newline - 1
      continue
    }
    if (char === '<' || char === '>') {
      // Process substitution, a heredoc or a here-string.
      if (next === '(' || (char === '<' && next === '<')) return null
      // A file descriptor number or {name} right before belongs to it.
      const only = parts.length === 1 ? parts[0] : undefined
      if (only && !only.quoted && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(only.text)) parts = []
      endWord()
      while (/[>&|]/.test(line[index + 1] ?? '')) index += 1
      // >&2 and the like name no file.
      if (line[index] === '&' && /[\d-]/.test(line[index + 1] ?? '')) {
        while (/[\d-]/.test(line[index + 1] ?? '')) index += 1
        continue
      }
      skipNext = true
      continue
    }
    if (char === '(') {
      // name() defines a function and name=(...) sets an array; any other
      // text right before ( makes a zsh glob or an extended pattern.
      const before = parts.map((part) => part.text).join('')
      if (parts.length > 0 && next !== ')' && !before.endsWith('=')) return null
      endWord()
      endCommand()
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === ')') {
      endWord()
      endCommand()
      continue
    }
    if (char === ' ' || char === '\t') {
      endWord()
      continue
    }
    add(char, false)
  }
  endWord()
  endCommand()
  return unknown ? null : commands
}

function wordOf(parts: readonly Part[]): Word {
  const first = parts[0]
  let assignment: Word['assignment'] = 'no'
  if (first && !first.quoted) {
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(first.text)) assignment = 'yes'
    else if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(first.text)) assignment = 'maybe'
  }
  const plain = parts.length === 1 && first !== undefined && !first.quoted
  return { text: expandedText(parts), plain, assignment }
}

// A word's text with what an unquoted glob or brace list expands to as
// unknown text.
function expandedText(parts: readonly Part[]): string {
  const raw = parts.map((part) => part.text).join('')
  const lastClose = raw.lastIndexOf(']')
  let offset = 0
  let out = ''
  let braces = false
  for (const part of parts) {
    if (part.quoted) {
      out += part.text
      offset += part.text.length
      continue
    }
    for (let index = 0; index < part.text.length; index += 1) {
      const char = part.text[index] ?? ''
      const at = offset + index
      // {a,b} and {1..3} make several words.
      if (char === '{' && !braces) {
        braces = true
        const comma = raw.indexOf(',', at)
        const dots = raw.indexOf('..', at)
        const separator = Math.min(...[comma, dots].filter((found) => found >= 0))
        if (Number.isFinite(separator) && raw.lastIndexOf('}') > separator) return UNKNOWN
      }
      if (char === '*' || char === '?') out += UNKNOWN
      else if (char === '[' && lastClose > at) {
        const close = part.text.indexOf(']', index + 1)
        if (close < 0) return UNKNOWN
        out += UNKNOWN
        index = close
      } else out += char
    }
    offset += part.text.length
  }
  return out
}

// The most hex digits $'\x', $'\u' and $'\U' take.
const HEX_DIGITS: Record<string, number> = { x: 2, u: 4, U: 8 }

// $'...': the text with its escapes worked out, and the closing quote.
function ansiCString(line: string, start: number): { text: string; end: number } | null {
  const simple: Record<string, string> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  }
  let text = ''
  for (let index = start; index < line.length; index += 1) {
    const char = line[index] ?? ''
    if (char === "'") {
      // The shell ends the string at a NUL.
      const nul = text.indexOf('\0')
      return { text: nul < 0 ? text : text.slice(0, nul), end: index }
    }
    if (char !== '\\') {
      text += char
      continue
    }
    const code = line[index + 1] ?? ''
    index += 1
    const octal = /^[0-7]{1,3}/.exec(line.slice(index, index + 3))
    const hex = HEX_DIGITS[code]
    const digits = hex ? /^[0-9a-fA-F]+/.exec(line.slice(index + 1, index + 1 + hex)) : null
    if (simple[code] !== undefined) text += simple[code]
    else if (octal) {
      text += String.fromCharCode(Number.parseInt(octal[0], 8) & 255)
      index += octal[0].length - 1
    } else if (digits) {
      const point = Number.parseInt(digits[0], 16)
      text += point <= 0x10ffff ? String.fromCodePoint(point) : ''
      index += digits[0].length
    } else if (code === 'c' && index + 1 < line.length) {
      text += String.fromCharCode(line.charCodeAt(index + 1) & 31)
      index += 1
    } else text += `\\${code}`
  }
  return null
}

// "...": the text, with UNKNOWN for each expansion, and the closing quote.
function doubleQuoted(line: string, start: number): { text: string; end: number } | null {
  let text = ''
  for (let index = start; index < line.length; index += 1) {
    const char = line[index] ?? ''
    if (char === '"') return { text, end: index }
    if (char === '\\') {
      // Only these lose the backslash; it joins lines before a newline.
      const next = line[index + 1] ?? ''
      if (next === '\n') index += 1
      else if ('$`"\\'.includes(next) && next !== '') {
        text += next
        index += 1
      } else text += char
      continue
    }
    if (char === '`') return null
    if (char === '$') {
      const end = expansionEnd(line, index)
      if (end === null) return null
      text += end === index + 1 ? '$' : UNKNOWN
      index = end - 1
      continue
    }
    text += char
  }
  return null
}

// Where the expansion at a $ ends (index + 1 for a $ that is just itself);
// null for command substitution or an expansion that does not close.
function expansionEnd(line: string, index: number): number | null {
  let at = index + 1
  // zsh's $=name, $~name, $^name and $+name.
  if (/[=~^+]/.test(line[at] ?? '') && /[A-Za-z_{]/.test(line[at + 1] ?? '')) at += 1
  const next = line[at] ?? ''
  if (next === '(') return line[at + 1] === '(' ? arithmeticEnd(line, at) : null
  if (next === '{' || next === '[') {
    const close = next === '{' ? '}' : ']'
    let depth = 0
    for (let scan = at; scan < line.length; scan += 1) {
      const char = line[scan]
      if (char === '\\') scan += 1
      else if (char === '`' || (char === '$' && line[scan + 1] === '(')) return null
      else if (char === next) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) return scan + 1
      }
    }
    return null
  }
  if (/[A-Za-z_]/.test(next)) {
    while (/[A-Za-z0-9_]/.test(line[at] ?? '')) at += 1
    return at
  }
  if (/[0-9@*#?$!-]/.test(next)) return at + 1
  return index + 1
}

// Where $((...)) ends; null when it holds what could run a command (a
// command substitution, quotes, an array subscript) or does not close.
function arithmeticEnd(line: string, open: number): number | null {
  let depth = 0
  for (let scan = open; scan < line.length; scan += 1) {
    const char = line[scan] ?? ''
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        const inner = line.slice(open + 2, scan - 1)
        if (line[scan - 1] !== ')' || /[`'"\\[;\n]|\$\(/.test(inner)) return null
        return scan + 1
      }
    }
  }
  return null
}
