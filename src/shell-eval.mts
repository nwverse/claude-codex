import { RESERVED, type Word } from './shell-words.mjs'
import { UNKNOWN } from './wildcards.mjs'

// Text a command line has the shell run later, which reading the line once
// cannot follow (see shell-commands.mts). The checks read the raw line,
// quoted text included, so a bash -c or eval script counts too, and the
// parsed words, quotes removed, so `'PS''4'` is PS4 as well.

// Names whose setting runs text later, however they are set: PS4 (set -x
// expands it before each command), an exported bash function, zsh's
// function, alias and option tables, and zsh's glob_subst (a glob qualifier
// in a variable runs code), which sh and ksh emulation turn on.
const RUNS_LATER =
  /\bPS4\b|BASH_FUNC_|\b(?:dis_)?(?:functions|aliases|galiases|saliases)(?:\[|\+?=)|\boptions\[|\bemulate\s+(?:-\w+\s+)*(?:sh|ksh)\b/
// zsh's tables, which `set -A name` fills.
const TABLES = /^(?:dis_)?(?:functions|aliases|galiases|saliases|options)$/

// zsh ignores case and underscores in option names.
function globSubst(text: string): boolean {
  return text.toLowerCase().replaceAll('_', '').includes('globsubst')
}

export function runsLater(line: string, commands: readonly (readonly Word[])[]): boolean {
  if (RUNS_LATER.test(line) || globSubst(line)) return true
  return commands.some((words) =>
    words.some((word) => RUNS_LATER.test(word.text) || globSubst(word.text)),
  )
}

// A name with no expansion in it, as a setter's target should be.
function isLiteralName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\u0000]*\])?$/.test(text)
}

// Whether a builtin that sets variables or options names its target with
// text built when the line runs (n=PS; printf -v "${n}4" ...): what it sets
// cannot be told, so neither can what that runs later. `words` start at a
// command (shell-commands.mts checks every place one may start, behind
// builtin, command, time and the like too).
export function hidesTarget(words: readonly Word[]): boolean {
  let at = 0
  while (
    at < words.length &&
    (words[at]?.assignment === 'yes' ||
      (words[at]?.plain === true && RESERVED.has(words[at]?.text ?? '')))
  )
    at += 1
  const program = words[at]?.text ?? ''
  const name = program.slice(program.lastIndexOf('/') + 1)
  const args = words.slice(at + 1).map((word) => word.text)
  // The values of the options in `valueTargets`, which name a target, and
  // the operands after the options; `values` are the options that take a
  // value.
  const targets = (values: string, valueTargets = ''): { named: string[]; rest: string[] } => {
    const found: string[] = []
    let index = 0
    for (; index < args.length; index += 1) {
      const arg = args[index] ?? ''
      if (arg === '--') {
        index += 1
        break
      }
      if (!/^[-+][a-zA-Z]+$/.test(arg)) break
      const letters = arg.slice(1)
      const valued = [...letters].findIndex((letter) => values.includes(letter))
      if (valued < 0) continue
      const value = valued < letters.length - 1 ? letters.slice(valued + 1) : (args[++index] ?? '')
      if (valueTargets.includes(letters[valued] ?? '')) found.push(value)
    }
    return { named: found, rest: args.slice(index) }
  }
  let checked: string[] = []
  if (name === 'printf') checked = targets('v', 'v').named
  else if (name === 'wait') checked = targets('fnp', 'p').named
  else if (name === 'read') {
    const { named, rest } = targets('adinNptu', 'a')
    checked = [...named, ...rest]
  } else if (name === 'mapfile' || name === 'readarray')
    checked = targets('dnOsuCc').rest.slice(0, 1)
  else if (name === 'getopts') checked = targets('').rest.slice(1, 2)
  else if (/^(?:declare|typeset|local|export|readonly|integer|float)$/.test(name))
    checked = targets('').rest.map((arg) => /^[^=+]*/.exec(arg)?.[0] ?? '')
  else if (name === 'set') {
    // set -A name (zsh, ksh), set -o option.
    const option = args.findIndex((arg) => /^[-+][a-zA-Z]*[Ao]$/.test(arg))
    if (option >= 0) {
      const target = args[option + 1] ?? ''
      if (/A$/.test(args[option] ?? '') && TABLES.test(target)) return true
      checked = [target]
    }
  } else if (name === 'setopt' || name === 'unsetopt')
    return args.some((arg) => arg.includes(UNKNOWN))
  return checked.some((target) => !isLiteralName(target))
}

// bash and zsh evaluate array subscripts and arithmetic, following names
// to their values: if x holds a[$(cmd)], then (( x )), ${s:x}, a[x]=1,
// ${!x} or zsh's $a[x] runs cmd. So a line that evaluates something is
// unknown when a subscript in it holds an expansion or a printf escape
// (`subscripts`, from shell-words.mts), or when what it evaluates names a
// variable filled from text the line does not show: read, mapfile,
// printf -v, getopts, select and for targets, ${x:=...}, the positional
// parameters, and assignments whose value holds [, $, a backtick, a
// backslash or unknown text, or names such a variable. A line that
// evaluates nothing asks for none of this.
export function evaluatesHiddenText(
  line: string,
  commands: readonly (readonly Word[])[],
  subscripts: boolean,
): boolean {
  const evaluated = evaluatedNames(line, commands)
  if (evaluated === null) return false
  if (subscripts) return true
  const tainted = taintedNames(line, commands)
  return [...evaluated].some((name) => tainted.all || tainted.names.has(name))
}

// What stands for the positional parameters ($1, ${2}, $@, $*) among names.
const POSITIONAL = '$@'

// Builtins that evaluate the names (and subscripts) they are given.
const NAMING =
  /\b(?:declare|export|float|getopts|integer|local|mapfile|printf|read|readarray|readonly|typeset|unset|wait)\b/
// Builtins that give a variable the integer attribute (-i, or zsh's
// integer), whose later assignments are evaluated as arithmetic.
const DECLARATIONS = new Set(['declare', 'export', 'local', 'readonly', 'typeset'])

function declaresInteger(commands: readonly (readonly Word[])[]): boolean {
  return commands.some((words) =>
    words.some((word, at) => {
      const name = word.text.slice(word.text.lastIndexOf('/') + 1)
      if (name === 'integer') return true
      if (!DECLARATIONS.has(name)) return false
      for (let option = at + 1; /^[-+][a-zA-Z]+$/.test(words[option]?.text ?? ''); option += 1)
        if (words[option]?.text.includes('i')) return true
      return false
    }),
  )
}

// Every position where the next ], } or command separator is, at or after
// each index (line.length for none).
function nextOf(line: string, test: (char: string) => boolean): Int32Array {
  const next = new Int32Array(line.length + 1)
  next[line.length] = line.length
  for (let index = line.length - 1; index >= 0; index -= 1)
    next[index] = test(line[index] ?? '') ? index : (next[index + 1] ?? line.length)
  return next
}

// The names a line evaluates as arithmetic or as a variable name, with
// POSITIONAL for the positional parameters; null when it evaluates nothing.
// A name after ${# is not one: its length is.
function evaluatedNames(line: string, commands: readonly (readonly Word[])[]): Set<string> | null {
  // Most lines (and most words a shell's -c reads) hold nothing that could
  // evaluate: skip the tables.
  if (
    !/[([{$]|-(?:eq|ne|lt|le|gt|ge|v)\b|\b(?:let|test|integer)\b/.test(line) &&
    !NAMING.test(line)
  )
    return null
  const length = line.length
  const marks = new Int32Array(length + 1)
  let found = false
  const mark = (from: number, to: number): void => {
    found = true
    if (to <= from) return
    marks[from] = (marks[from] ?? 0) + 1
    marks[to] = (marks[to] ?? 0) - 1
  }
  const close = nextOf(line, (char) => char === ']')
  const brace = nextOf(line, (char) => char === '}')
  const separator = nextOf(line, (char) => ';&|\n'.includes(char))
  const name = /[A-Za-z_][A-Za-z0-9_]*/y
  const nameAt = (at: number): number => {
    name.lastIndex = at
    return name.test(line) ? name.lastIndex : at
  }
  const naming = NAMING.test(line)
  const opens: number[] = []
  for (let index = 0; index < length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    // (( )) and $(( )).
    if (char === '(') opens.push(index)
    else if (char === ')') {
      const open = opens.pop()
      if (open !== undefined && line[open + 1] === '(') mark(open + 2, index)
    }
    if (char === '$' && next === '[') mark(index + 2, close[index + 2] ?? length)
    if (char === '$' && next === '{') {
      // ${!x}, ${a[i]}, ${s:offset}.
      let at = index + 2
      const indirect = line[at] === '!'
      if (indirect || line[at] === '#') at += 1
      const end = /[@*0-9]/.test(line[at] ?? '') ? at + 1 : nameAt(at)
      // ${!a[@]} lists keys and ${!a@} names, not what a names.
      const listing = /^(?:\[[@*]\]|[@*])/.test(line.slice(end, end + 3))
      if (indirect && !listing) mark(at, end)
      let after = end
      if (line[end] === '[') {
        const shut = close[end + 1] ?? length
        mark(end + 1, shut)
        after = shut + 1
      }
      if (line[after] === ':' && !'-=+?'.includes(line[after + 1] ?? ''))
        mark(after + 1, brace[after + 1] ?? length)
    } else if (char === '$' && /[A-Za-z_]/.test(next ?? '')) {
      // zsh's $a[i].
      const end = nameAt(index + 1)
      if (line[end] === '[') mark(end + 1, close[end + 1] ?? length)
    }
    // a[i]=, a[i]+=, and with a builtin that takes names, any a[i].
    if (char === '[' && /[A-Za-z0-9_]/.test(line[index - 1] ?? '')) {
      const shut = close[index + 1] ?? length
      const assigns = line[shut + 1] === '=' || (line[shut + 1] === '+' && line[shut + 2] === '=')
      if (assigns || naming) mark(index + 1, shut)
    }
  }
  for (const open of opens) if (line[open + 1] === '(') mark(open + 2, length)
  for (const match of line.matchAll(/\blet\b/g)) {
    const start = match.index + 3
    mark(start, separator[start] ?? length)
  }
  // [[ a -eq b ]] evaluates both sides; test -v and [ -v a name.
  const token = (from: number, step: 1 | -1): void => {
    let at = from
    while (/\s/.test(line[at] ?? '') && at >= 0 && at < length) at += step
    let end = at
    while (end >= 0 && end < length && !/\s/.test(line[end] ?? '') && Math.abs(end - at) < 256)
      end += step
    if (step === 1) mark(at, end)
    else mark(end + 1, at + 1)
  }
  for (const match of line.matchAll(/\s-(?:eq|ne|lt|le|gt|ge)\b/g)) {
    token(match.index, -1)
    token(match.index + match[0].length, 1)
  }
  for (const match of line.matchAll(/(?:\btest|\[)\s+(?:!\s+)?-v\s+/g))
    token(match.index + match[0].length, 1)
  if (naming) found = true
  const integer = declaresInteger(commands)
  if (!found && !integer) return null
  const depth = new Int32Array(length + 1)
  for (let index = 0, running = 0; index < length; index += 1) {
    running += marks[index] ?? 0
    depth[index] = running
  }
  const names = new Set<string>()
  for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const before = line.slice(Math.max(0, match.index - 3), match.index)
    if ((depth[match.index] ?? 0) > 0 && !/(?:\$\{|\$)#$/.test(before)) names.add(match[0])
  }
  // $1, ${2}, $@ and $* take what the caller passed.
  for (const match of line.matchAll(/\$\{?[0-9@*]/g))
    if ((depth[match.index] ?? 0) > 0) names.add(POSITIONAL)
  // After an integer declaration, every assignment is arithmetic.
  if (integer)
    for (const words of commands)
      for (const word of words) {
        const value = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(word.text)?.[1]
        for (const named of value?.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) names.add(named)
      }
  return names
}

// The variables a line fills from text it does not show; `all` when it
// cannot tell (a target list too long to read).
function taintedNames(
  line: string,
  commands: readonly (readonly Word[])[],
): { all: boolean; names: Set<string> } {
  const names = new Set<string>([POSITIONAL])
  let all = false
  const separator = nextOf(line, (char) => ';&|\n'.includes(char))
  // What is read after each setter, at most 1 KB each and 256 KB in all;
  // past that every name counts as filled.
  let budget = 256 * 1024
  const textAfter = (start: number): string => {
    const end = Math.min(separator[start] ?? line.length, start + 1024)
    if (end - start >= 1024 || budget < end - start) all = true
    budget -= end - start
    return all ? '' : line.slice(start, end)
  }
  const argsAfter = (start: number): string[] =>
    textAfter(start)
      .split(/\s+/)
      .map((arg) => arg.replace(/^["']|["']$/g, ''))
  const isName = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
  for (const match of line.matchAll(/\b(read|mapfile|readarray|getopts|printf|wait|select)\b/g)) {
    const command = match[1] ?? ''
    const args = argsAfter(match.index + match[0].length)
    if (command === 'printf' || command === 'wait') {
      // printf -v NAME, wait -p NAME.
      const flag = command === 'printf' ? 'v' : 'p'
      for (const [at, arg] of args.entries()) {
        const option = new RegExp(`^-[a-zA-Z]*${flag}(.*)$`).exec(arg)
        const target = option ? option[1] || args[at + 1] || '' : ''
        if (isName(target)) names.add(target)
      }
      continue
    }
    for (const arg of args) if (isName(arg)) names.add(arg)
    names.add({ read: 'REPLY', select: 'REPLY', getopts: 'OPTARG' }[command] ?? 'MAPFILE')
  }
  // for NAME in LIST takes what the list expands to; without `in`, the
  // positional parameters. An indexed array's keys (${!a[@]}) are numbers.
  const associative = /\s[-+][a-zA-Z]*A\b/.test(line)
  for (const match of line.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const rest = textAfter(match.index + match[0].length)
    const list = /^\s+in\b([^;\n]*)/.exec(rest)?.[1]
    if (list !== undefined && !associative && /^\s*"?\$\{![A-Za-z_]\w*\[[@*]\]\}"?\s*$/.test(list))
      continue
    if (list === undefined || /[[$`\\*?{]/.test(list)) names.add(match[1] ?? '')
  }
  for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) names.add(match[1] ?? '')
  // An array's elements are not read.
  for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\+?=\(/g)) names.add(match[1] ?? '')
  // Assignments, and the names whose value is another name.
  const pointedAt = new Map<string, string[]>()
  for (const words of commands)
    for (const word of words) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(word.text)
      if (!assignment) continue
      const [, target = '', value = ''] = assignment
      if (/[[$`\\]/.test(value) || (value.includes(UNKNOWN) && word.free)) names.add(target)
      else if (isName(value)) {
        const pointing = pointedAt.get(value)
        if (pointing) pointing.push(target)
        else pointedAt.set(value, [target])
      }
    }
  // A name that names a filled one is filled too, however long the chain.
  const pending = [...names]
  for (let filled = pending.pop(); filled !== undefined; filled = pending.pop())
    for (const target of pointedAt.get(filled) ?? [])
      if (!names.has(target)) {
        names.add(target)
        pending.push(target)
      }
  return { all, names }
}
