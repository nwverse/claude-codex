import type { Word } from './shell-words.mjs'
import { UNKNOWN } from './wildcards.mjs'

// Text a command line has the shell run later, which reading the line once
// cannot follow (see shell-commands.mts). Both checks read the raw line,
// quoted text included, so a bash -c or eval script counts too.

// Names whose setting runs text later, however they are set: PS4 (set -x
// expands it before each command), an exported bash function, zsh's
// function and alias tables, and zsh's glob_subst (a glob qualifier in a
// variable runs code), which sh and ksh emulation turn on.
const RUNS_LATER =
  /\bPS4\b|BASH_FUNC_|\b(?:dis_)?(?:functions|aliases|galiases|saliases)(?:\[|\+?=)|\bemulate\s+(?:-\w+\s+)*(?:sh|ksh)\b/
const GLOB_SUBST = /glob_?subst/i

export function runsLater(line: string): boolean {
  return RUNS_LATER.test(line) || GLOB_SUBST.test(line)
}

// bash and zsh evaluate array subscripts and arithmetic, following names
// to their values: if x holds a[$(cmd)], then (( x )), ${s:x}, a[x]=1,
// ${!x} or zsh's $a[x] runs cmd. So a line that evaluates something is
// unknown when a subscript in it holds an expansion or a printf escape
// (`subscripts`, from shell-words.mts), or when what it evaluates names a
// variable filled from text the line does not show: read, mapfile,
// printf -v, getopts, select and for targets, ${x:=...}, and assignments
// whose value holds [, $, a backtick, a backslash or unknown text, or names
// such a variable. A line that evaluates nothing asks for none of this.
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
      const options = words.slice(at + 1).filter((arg) => /^[-+][a-zA-Z]+$/.test(arg.text))
      return options.some((option) => option.text.includes('i'))
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

// The names a line evaluates as arithmetic or as a variable name; null when
// it evaluates nothing.
function evaluatedNames(line: string, commands: readonly (readonly Word[])[]): Set<string> | null {
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
      if (indirect) mark(at, end)
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
  const names = new Set<string>()
  let depth = 0
  let from = 0
  for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    for (; from <= match.index; from += 1) depth += marks[from] ?? 0
    if (depth > 0) names.add(match[0])
  }
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
  const names = new Set<string>()
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
  // positional parameters.
  for (const match of line.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const rest = textAfter(match.index + match[0].length)
    const list = /^\s+in\b([\s\S]*)$/.exec(rest)?.[1]
    if (list === undefined || /[[$`\\*?{]/.test(list)) names.add(match[1] ?? '')
  }
  for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) names.add(match[1] ?? '')
  // An array's elements are not read.
  for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\+?=\(/g)) names.add(match[1] ?? '')
  // Assignments, and the names whose value is another name.
  const links: [string, string][] = []
  for (const words of commands)
    for (const word of words) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(word.text)
      if (!assignment) continue
      const [, target = '', value = ''] = assignment
      if (/[[$`\\]/.test(value) || (value.includes(UNKNOWN) && word.free)) names.add(target)
      else if (isName(value)) links.push([target, value])
    }
  for (let grew = true; grew; ) {
    grew = false
    for (const [target, value] of links)
      if (names.has(value) && !names.has(target)) {
        names.add(target)
        grew = true
      }
  }
  return { all, names }
}
