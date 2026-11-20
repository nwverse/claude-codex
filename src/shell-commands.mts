import { evaluatesHiddenText, hidesTarget, runsLater } from './shell-eval.mjs'
import { parseLine, RESERVED, type Word } from './shell-words.mjs'
import { UNKNOWN } from './wildcards.mjs'

// The commands a shell command line can run, for matching Bash permission
// rules against it (see ask-rules.mts). The line is read the way bash and
// zsh read it (Claude Code runs it in the user's shell), and wherever the
// reading is unsure it takes every way the line could go: each command of a
// compound line, what a wrapper such as `sudo`, `timeout`, `xargs` or
// `find -exec` runs whichever of its options takes a value, the script a
// shell runs with -c, eval or trap. A word the shell works out when it runs
// ($VAR, a glob, a brace list) stands for any text. A line whose commands
// only the shell can tell has none, and the caller treats it as running
// anything: command substitution, a heredoc, a shell reading its commands
// from stdin, a zsh glob or extended pattern group anywhere (zsh's
// *(e:...:) runs code), and text the shell may run later (see
// shell-eval.mts). This reads the line as text, before it runs: it is not
// a sandbox against a command hidden on purpose.

export { UNKNOWN }

// macOS and Windows find a command whatever the case of its name.
export const COMMAND_NAMES_IGNORE_CASE =
  process.platform === 'darwin' || process.platform === 'win32'

// Every command a command line may run, each as its words joined by single
// spaces, with a program named by a path also under its file name; null
// when that cannot be told.
export function commandCandidates(line: string): string[] | null {
  const out = new Candidates()
  if (!collect(line, 0, NO_SCOPE, out)) return null
  // The whole line too, for a rule naming a compound command. It does not
  // count against the budget, so one long command can still be read.
  const whole = line.trim().replace(/\s+/g, ' ')
  return out.texts.has(whole) ? [...out.texts] : [...out.texts, whole]
}

const MAX_DEPTH = 6
const MAX_CANDIDATES = 2000
const MAX_CHARS = 200_000

// Commands that run the rest of their command line: `values` are the
// options that take the next word, `flags` those known to take none,
// `operands` the words between the options and the command (a duration, a
// file), and `assigns` that NAME=value words come before the command. An
// option not listed may or may not take the next word, so both readings
// count.
interface Runner {
  readonly values?: readonly string[]
  readonly flags?: readonly string[]
  readonly operands?: number
  readonly assigns?: boolean
}
const options = (...lists: string[]): string[] => lists.join(' ').split(' ')
const CHROOT: Runner = { values: options('-u -g -G --userspec --groups'), operands: 1 }
const ENV: Runner = {
  values: options('-u -C -P -S --unset --chdir --split-string'),
  assigns: true,
}
const NICE: Runner = { values: options('-n --adjustment') }
const STDBUF: Runner = { values: options('-i -o -e --input --output --error') }
const TIME: Runner = { values: options('-f -o --format --output') }
const TIMEOUT: Runner = { values: options('-k -s --kill-after --signal'), operands: 1 }
const RUNNERS: Record<string, Runner> = {
  // zsh's precommand modifier.
  '-': {},
  arch: { values: options('-arch -d -e') },
  builtin: {},
  busybox: {},
  caffeinate: { values: options('-t -w') },
  chroot: CHROOT,
  chrt: {
    values: options('-T -P -D --sched-runtime --sched-period --sched-deadline'),
    operands: 1,
  },
  command: {},
  coproc: { operands: 1 },
  doas: { values: options('-a -u -C'), assigns: true },
  env: ENV,
  exec: { values: options('-a') },
  flock: { values: options('-w -E --timeout --wait --conflict-exit-code'), operands: 1 },
  // `function name body` in zsh.
  function: { operands: 1 },
  // GNU coreutils as Homebrew installs them.
  gchroot: CHROOT,
  genv: ENV,
  gnice: NICE,
  gnohup: {},
  gstdbuf: STDBUF,
  gtime: TIME,
  gtimeout: TIMEOUT,
  ionice: { values: options('-c -n -p -P -u --class --classdata --pid --pgid --uid') },
  ltrace: { values: options('-a -A -e -l -n -o -p -s -u -x -D -F -w --output') },
  nice: NICE,
  nocorrect: {},
  noglob: {},
  nohup: {},
  nsenter: { values: options('-t -S -G --target --setuid --setgid') },
  numactl: {},
  parallel: {
    values: options(
      '-a -d -E -I -j -L -n -N -P -S',
      '--arg-file --colsep --delimiter --jobs --joblog --results --sshlogin --tmpdir',
    ),
    flags: options('-0 -k -m -q -u -v -X --keep-order --line-buffer --null --quote --ungroup'),
  },
  pkexec: { values: options('--user') },
  repeat: { operands: 1 },
  'sandbox-exec': { values: options('-f -n -p -D') },
  script: {
    values: options(
      '-B -E -I -m -o -O -T',
      '--log-in --log-io --log-out --log-timing --logging-format --output-limit',
    ),
    flags: options('-a -d -e -F -f -k -p -q -r --append --flush --force --quiet --return'),
    operands: 1,
  },
  setsid: {},
  stdbuf: STDBUF,
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
    assigns: true,
  },
  taskset: { operands: 1 },
  time: TIME,
  timeout: TIMEOUT,
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
  xcrun: { values: options('-sdk -toolchain --sdk --toolchain') },
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
    if (COMMAND_NAMES_IGNORE_CASE) for (const name of [...names]) names.add(name.toLowerCase())
    for (const name of names) this.addText([name, ...rest].join(' '))
    return !this.overflow
  }

  private addText(text: string): void {
    if (this.texts.has(text)) return
    this.chars += text.length
    if (this.texts.size >= MAX_CANDIDATES || this.chars > MAX_CHARS) this.overflow = true
    else this.texts.add(text)
  }
}

// What a line around a command sets up, by name, however it is set:
// BASH_ENV (a shell runs that file's commands first), ENV (an interactive
// POSIX shell does), and an array (declare reads an expansion into one as
// code).
interface Scope {
  readonly bashEnv: boolean
  readonly env: boolean
  readonly arrays: boolean
}
const NO_SCOPE: Scope = { bashEnv: false, env: false, arrays: false }

function collect(line: string, depth: number, outer: Scope, out: Candidates): boolean {
  if (depth > MAX_DEPTH) return false
  const parsed = parseLine(line)
  if (parsed === null || runsLater(line, parsed.commands)) return false
  if (evaluatesHiddenText(line, parsed.commands, parsed.subscripts)) return false
  // Named in the raw line or in a word with its quotes removed.
  const texts = `${line}\n${parsed.commands.flatMap((words) => words.map((word) => word.text)).join('\n')}`
  const scope: Scope = {
    bashEnv: outer.bashEnv || /\bBASH_ENV\b/.test(texts),
    env: outer.env || /\bENV\b/.test(texts),
    arrays: outer.arrays || makesArrays(line, parsed.commands),
  }
  return parsed.commands.every((words) => analyze(words, depth, scope, out))
}

// Whether a line makes an array: name=(...), name[i]=..., read -a,
// mapfile, or a declaration with -a or -A.
function makesArrays(line: string, commands: readonly (readonly Word[])[]): boolean {
  if (/[A-Za-z0-9_]\+?=\(|[A-Za-z_][A-Za-z0-9_]*\[[^\]\n]{0,256}\]\+?=/.test(line)) return true
  return commands.some((words) =>
    words.some((word, at) => {
      const name = programName(word.text)
      if (name === 'mapfile' || name === 'readarray') return true
      if (!['read', 'declare', 'typeset', 'local'].includes(name)) return false
      const array = name === 'read' ? /^-[a-zA-Z]*a/ : /^[-+][a-zA-Z]*[aA]/
      for (let option = at + 1; /^[-+]/.test(words[option]?.text ?? ''); option += 1)
        if (array.test(words[option]?.text ?? '')) return true
      return false
    }),
  )
}

// The commands of one simple command: its own, and those its wrappers run.
function analyze(words: readonly Word[], depth: number, scope: Scope, out: Candidates): boolean {
  if (depth > MAX_DEPTH) return false
  const starts = new Set([0])
  for (let index = 0; index < words.length; index += 1) {
    if (!starts.has(index)) continue
    const word = words[index] as Word
    if ((word.plain && RESERVED.has(word.text)) || word.assignment === 'yes') {
      starts.add(index + 1)
      continue
    }
    if (word.assignment === 'maybe') starts.add(index + 1)
    if (hidesTarget(words.slice(index))) return false
    if (!out.add(words.slice(index))) return false
    const args = words.slice(index + 1).map((next) => next.text)
    const call: Call = { name: programName(word.text), words, index, args, depth, scope, out }
    const more = runs(call)
    if (more === null) return false
    for (const start of more) starts.add(start)
  }
  return true
}

// A command at `index` of its words, and what it is read with.
interface Call {
  readonly name: string
  readonly words: readonly Word[]
  readonly index: number
  readonly args: readonly string[]
  readonly depth: number
  readonly scope: Scope
  readonly out: Candidates
}

// Where the commands that a command runs start, after adding those it runs
// from text (a shell's -c script, eval) to `out`; null when what it runs
// cannot be told.
type Handler = (call: Call) => number[] | null

function runs(call: Call): number[] | null {
  const shell = call.name.replace(/[-\d.]+$/, '')
  if (SHELLS.has(shell)) return shellRuns(call, shell) ? [] : null
  const handler = Object.hasOwn(HANDLERS, call.name) ? HANDLERS[call.name] : undefined
  if (handler) return handler(call)
  return Object.hasOwn(RUNNERS, call.name) ? runnerStarts(call).starts : []
}

const HANDLERS: Record<string, Handler> = {
  '.': sourceRuns,
  // An alias runs its text in place of a later command: unknown.
  alias: (call) => (call.args.some((arg) => arg.includes('=')) ? null : []),
  // command -v and -V only say what a name is.
  command: (call) =>
    leadingOptions(call.args).some((arg) => /^-[a-zA-Z]*[vV]/.test(arg))
      ? []
      : runnerStarts(call).starts,
  declare: declareRuns,
  doas: sudoRuns,
  env: envRuns,
  eval: (call) => (reparse(call, call.args.join(' ')) ? [] : null),
  export: declareRuns,
  fd: execRuns,
  find: execRuns,
  float: declareRuns,
  flock: (call) => (commandOption(call) ? runnerStarts(call).starts : null),
  genv: envRuns,
  integer: declareRuns,
  local: declareRuns,
  mapfile: mapfileRuns,
  parallel: inputRuns,
  powershell: powershellRuns,
  pwsh: powershellRuns,
  readarray: mapfileRuns,
  readonly: declareRuns,
  runuser: suRuns,
  script: scriptRuns,
  source: sourceRuns,
  su: suRuns,
  sudo: sudoRuns,
  trap: trapRuns,
  typeset: declareRuns,
  watch: watchRuns,
  xargs: inputRuns,
  zargs: zargsRuns,
  // zstyle -e stores code that later lookups run.
  zstyle: (call) => (leadingOptions(call.args).some((arg) => /^-[a-zA-Z]*e/.test(arg)) ? null : []),
}

function reparse(call: Call, text: string): boolean {
  return collect(text, call.depth + 1, call.scope, call.out)
}

function analyzeNested(call: Call, words: readonly Word[]): boolean {
  return analyze(words, call.depth + 1, call.scope, call.out)
}

function runnerStarts(call: Call): { starts: number[]; ends: number[] } {
  const runner = Object.hasOwn(RUNNERS, call.name) ? RUNNERS[call.name] : undefined
  return commandStarts(call.words, call.index, runner ?? {})
}

// The words where a wrapper's command may start, and where its options may
// end (before its operands).
function commandStarts(
  words: readonly Word[],
  index: number,
  runner: Runner,
): { starts: number[]; ends: number[] } {
  const values = runner.values ?? []
  const flags = runner.flags ?? []
  const starts = new Set<number>()
  const ends = new Set<number>()
  const after = (at: number): void => {
    let first = at
    // env and sudo take NAME=value words, quoted or not, before the command.
    while (runner.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first]?.text ?? '')) first += 1
    ends.add(first)
    for (let skip = 0; skip <= (runner.operands ?? 0); skip += 1)
      if (first + skip < words.length) starts.add(first + skip)
  }
  const seen = new Set<number>()
  const pending = [index + 1]
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (seen.has(at)) continue
    seen.add(at)
    const text = words[at]?.text
    if (text === undefined) ends.add(at)
    else if (text === '--') after(at + 1)
    else if (!text.startsWith('-')) after(at)
    else if (values.includes(text)) pending.push(at + 2)
    else if (
      flags.includes(text) ||
      (text.startsWith('--')
        ? text.includes('=')
        : values.some((value) => !value.startsWith('--') && text.startsWith(value)))
    )
      pending.push(at + 1)
    // An option this does not know: it may take the next word or not.
    else pending.push(at + 1, at + 2)
  }
  return { starts: [...starts], ends: [...ends] }
}

// The arguments up to the first that is not an option (any word may be an
// option's value).
function leadingOptions(args: readonly string[]): readonly string[] {
  const end = args.findIndex((arg, at) => !arg.startsWith('-') && !args[at - 1]?.startsWith('-'))
  return end < 0 ? args : args.slice(0, end)
}

// A shell's -c script. bash, sh and zsh take their options up to the first
// other word, -o and -O with a value, and that word is the script. A shell
// with no -c and no script file, or whose file is stdin, reads its commands
// from stdin, and one started after BASH_ENV or ENV was set reads that
// file first: unknown.
function shellRuns(call: Call, shell: string): boolean {
  if (call.scope.bashEnv) return false
  const args = call.args
  let script = false
  let stdin = false
  let interactive = false
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
      if (arg.startsWith('-') && letters.includes('i')) interactive = true
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
        if (!reparse(call, arg.slice(arg.indexOf('=') + 1))) return false
      } else if (['--rcfile', '--init-file', '--emulate'].includes(arg)) at += 1
      else if (arg === '--version' || arg === '--help') info = true
      else if (arg === '--interactive') interactive = true
      continue
    }
    break
  }
  if (call.scope.env && interactive) return false
  if (script) {
    if (exact) return at >= args.length || reparse(call, args[at] ?? '')
    // Any word after the -c may be the script.
    const first = args.findIndex((arg) => /^-[A-Za-z]*[cC]/.test(arg) || arg.startsWith('--'))
    return args.slice(first + 1).every((arg) => reparse(call, arg))
  }
  return info || (at < args.length && !stdin && !mayBeStdin(args[at] ?? ''))
}

// Whether a path may name the standard input (/dev/stdin, /dev/fd/0,
// /proc/self/fd/0), also when part of it is unknown.
function mayBeStdin(path: string): boolean {
  if (path === '-') return true
  const unknown = path.lastIndexOf(UNKNOWN)
  const tail = path.slice(unknown + 1)
  if (/(?:^|\/)(?:stdin|fd\/\d+)$/.test(tail)) return true
  return unknown >= 0 && ('/stdin'.endsWith(tail) || /^(?:(?:.*\/)?fd|d)?\/?\d+$/.test(tail))
}

// source and . run a file; one that is stdin runs what the pipe holds.
function sourceRuns(call: Call): number[] | null {
  const file = call.args.find((arg) => arg !== '--')
  return file !== undefined && mayBeStdin(file) ? null : []
}

// su and runuser run their -c command with the user's shell; without one
// the shell reads its commands from stdin.
function suRuns(call: Call): number[] | null {
  return hasCommandOption(call.args) && commandOption(call) ? [] : null
}

// sudo -s or -i, and doas -s, with no command start a shell reading its
// commands from stdin.
function sudoRuns(call: Call): number[] | null {
  const { starts } = runnerStarts(call)
  const shell = leadingOptions(call.args).some(
    (arg) => /^-[a-zA-Z]*[is]/.test(arg) || arg === '--shell' || arg === '--login',
  )
  return shell && starts.length === 0 ? null : starts
}

// env -S splits its value into the command and its arguments.
function envRuns(call: Call): number[] | null {
  const split = leadingOptions(call.args).findIndex((arg) =>
    /^(?:-[a-zA-Z]*S|--split-string)/.test(arg),
  )
  if (split >= 0) {
    const arg = call.args[split] ?? ''
    const attached = /^(?:-[a-zA-Z]*S|--split-string=?)(.*)$/.exec(arg)?.[1] ?? ''
    if (!reparse(call, [attached, ...call.args.slice(split + 1)].join(' '))) return null
  }
  return runnerStarts(call).starts
}

// script with -c runs that; without a command after its file it starts a
// shell reading stdin.
function scriptRuns(call: Call): number[] | null {
  if (hasCommandOption(call.args)) return commandOption(call) ? [] : null
  const { starts, ends } = runnerStarts(call)
  return ends.some((end) => end + 1 >= call.words.length) ? null : starts
}

// watch runs its arguments, joined, with sh -c.
function watchRuns(call: Call): number[] | null {
  for (const start of runnerStarts(call).starts) {
    const text = call.words.slice(start).map((word) => word.text)
    if (!reparse(call, text.join(' '))) return null
  }
  return []
}

function trapRuns(call: Call): number[] | null {
  const action = call.args.find((arg) => !/^-[-lp]*$/.test(arg))
  return action === undefined || action === '-' || reparse(call, action) ? [] : null
}

// declare and its kin read a value as an array again, running what it
// holds, when it is a quoted name=(...), or (declare, typeset and local)
// when it holds an expansion and the variable is an array: given -a or
// -A, or made one on the same line.
function declareRuns(call: Call): number[] | null {
  if (call.args.some((arg) => arg.includes('=('))) return null
  if (!['declare', 'local', 'typeset'].includes(call.name)) return []
  for (const arg of call.args) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(arg)?.[1]
    if (name && arg.includes(UNKNOWN) && (call.scope.arrays || BASH_ARRAYS.has(name))) return null
  }
  return []
}

// The arrays bash makes itself.
const BASH_ARRAYS = new Set([
  'BASH_ALIASES',
  'BASH_ARGC',
  'BASH_ARGV',
  'BASH_CMDS',
  'BASH_LINENO',
  'BASH_REMATCH',
  'BASH_SOURCE',
  'BASH_VERSINFO',
  'COMP_WORDS',
  'COPROC',
  'DIRSTACK',
  'FUNCNAME',
  'GROUPS',
  'PIPESTATUS',
])

// mapfile -C runs its callback every few lines it reads.
function mapfileRuns(call: Call): number[] | null {
  return leadingOptions(call.args).some((arg) => /^-[a-zA-Z]*C/.test(arg)) ? null : []
}

// Its -Command script is PowerShell, which this does not read.
function powershellRuns(call: Call): number[] | null {
  if (call.args.some((arg) => /^-(?:c|command|e|ec|encodedcommand)$/i.test(arg))) return null
  return call.args.some((arg) => !arg.startsWith('-')) ? [] : null
}

// find and fd run what follows -exec and the like, with a path for {}; fd
// adds the path when the command names none.
function execRuns(call: Call): number[] | null {
  const exec = EXEC_OPTIONS[call.name] ?? []
  const args = call.args
  for (let at = 0; at < args.length; at += 1) {
    if (!exec.includes(args[at] ?? '')) continue
    let end = args.length
    if (call.name === 'find')
      for (let stop = at + 1; stop < args.length; stop += 1)
        if (args[stop] === ';' || (args[stop] === '+' && args[stop - 1]?.includes('{}'))) {
          end = stop
          break
        }
    const command = call.words.slice(call.index + 2 + at, call.index + 1 + end)
    const placeholder = (text: string) => /\{[/.]*\}/.test(text)
    if (!analyzeNested(call, substituted(command, placeholder, call.name === 'fd'))) return null
  }
  return []
}

// xargs and parallel add arguments from their input, or put them in place
// of the replacement string. parallel with no command runs its inputs.
function inputRuns(call: Call): number[] | null {
  const { starts } = runnerStarts(call)
  const inputs = (start: number) => /^:{3,4}\+?$/.test(call.words[start]?.text ?? '')
  if (call.name === 'parallel' && (starts.length === 0 || starts.some(inputs))) return null
  const replace = new Set(['{}'])
  for (const [at, arg] of call.args.entries()) {
    if (arg === '-I' || arg === '-J') replace.add(call.args[at + 1] ?? '{}')
    const attached = /^(?:-[IJi]|--replace=)(.+)$/.exec(arg)
    if (attached?.[1]) replace.add(attached[1])
  }
  const placeholder = (text: string) => [...replace].some((value) => text.includes(value))
  for (const start of starts) {
    let command = call.words.slice(start)
    // GNU parallel's inputs (::: a b, :::: file) end its command.
    if (call.name === 'parallel') {
      const inputs = command.findIndex((word) => /^:{3,4}\+?$/.test(word.text))
      if (inputs >= 0) command = command.slice(0, inputs)
    }
    if (!analyzeNested(call, substituted(command, placeholder, true))) return null
  }
  return []
}

// zsh's zargs runs what follows a -- with its inputs added.
function zargsRuns(call: Call): number[] | null {
  for (const [at, arg] of call.args.entries()) {
    if (arg !== '--') continue
    const command = call.words.slice(call.index + 2 + at)
    const placeholder = (text: string) => text.includes('{}')
    if (command.length > 0 && !analyzeNested(call, substituted(command, placeholder, true)))
      return null
  }
  return []
}

function hasCommandOption(args: readonly string[]): boolean {
  return args.some((arg) => /^(?:-[a-zA-Z]*c|--command)/.test(arg))
}

// The -c / --command option's command, for su, flock and script.
function commandOption(call: Call): boolean {
  for (const [at, arg] of call.args.entries()) {
    if (arg === '-c' || arg === '--command' || /^-[a-zA-Z]+c$/.test(arg)) {
      if (!reparse(call, call.args[at + 1] ?? '')) return false
    } else if (/^--command=/.test(arg)) {
      if (!reparse(call, arg.slice('--command='.length))) return false
    } else if (/^-c./.test(arg) && !reparse(call, arg.slice(2))) return false
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
  return { text: UNKNOWN, plain: false, assignment: 'no', free: true }
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
