import { UNKNOWN } from './wildcards.mjs'

// A shell command line read into its simple commands and their words, as
// bash and zsh read it, for shell-commands.mts. Quotes are removed, what
// the shell expands when it runs (a variable, a glob, a brace list) is
// UNKNOWN, and a line only the shell can tell apart (command substitution,
// a heredoc, a zsh glob group, text it runs later) reads as null.

export interface Word {
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

// Reserved words that may come before a command.
export const RESERVED = new Set([
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

// A case being read: its word, its patterns or a pattern's commands.
interface CaseState {
  at: 'subject' | 'patterns' | 'body'
  // Words after `case`, and whether the current pattern list has begun.
  seen: number
  started: boolean
}

// The simple commands of a command line as their words, with quotes
// removed and redirections dropped; null for what only the shell can tell.
// A case's patterns and an array's elements are left out (they only match
// or hold text), and a [[ ]] test is one command whatever ( ) | & < > it
// holds.
export function parseLine(line: string): Word[][] | null {
  if (line.includes(UNKNOWN)) return null
  const commands: Word[][] = []
  let words: Word[] = []
  let parts: Part[] = []
  let skipNext = false
  let unknown = false
  const cases: CaseState[] = []
  let array = false
  let test = false
  const reading = (): 'commands' | 'patterns' | 'array' | 'test' => {
    if (test) return 'test'
    if (array) return 'array'
    return cases.at(-1)?.at === 'patterns' ? 'patterns' : 'commands'
  }
  const add = (text: string, quoted: boolean): void => {
    const last = parts.at(-1)
    if (last && last.quoted === quoted) parts[parts.length - 1] = { text: last.text + text, quoted }
    else parts.push({ text, quoted })
  }
  const endCommand = (): void => {
    if (words.length > 0) commands.push(words)
    words = []
    // A case with no `in` after its word is not read as one.
    if (cases.at(-1)?.at === 'subject') cases.pop()
  }
  const endWord = (): void => {
    if (parts.length === 0) return
    if (runsLater(parts.map((part) => part.text).join(''))) unknown = true
    const word = wordOf(parts)
    parts = []
    if (skipNext) {
      skipNext = false
      return
    }
    const now = reading()
    const top = cases.at(-1)
    if (now === 'patterns') {
      // A pattern only matches; esac ends the case.
      if (top && word.plain && word.text === 'esac' && !top.started) cases.pop()
      else if (top) top.started = true
      return
    }
    if (now === 'array') return
    if (now === 'test') {
      words.push(word)
      if (word.plain && word.text === ']]') {
        test = false
        endCommand()
      }
      return
    }
    if (top?.at === 'subject') {
      top.seen += 1
      if (top.seen === 2 && word.plain && word.text === 'in') {
        words.push(word)
        top.at = 'patterns'
        top.started = false
        endCommand()
        return
      }
      if (top.seen >= 2) cases.pop()
    }
    // { and } open and close a group, and zsh takes a command right after
    // a test's ]] (`if [[ -n $x ]] git push`).
    if (word.plain && (word.text === '{' || word.text === '}')) {
      endCommand()
      return
    }
    if (word.plain && words.every((before) => before.plain && RESERVED.has(before.text))) {
      if (word.text === '[[') test = true
      else if (word.text === 'case') cases.push({ at: 'subject', seen: 0, started: false })
      else if (word.text === 'esac' && top?.at === 'body') cases.pop()
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
    // Process substitution, a heredoc or a here-string.
    if ((char === '<' || char === '>') && (next === '(' || (char === '<' && next === '<')))
      return null
    // In a [[ ]] test these are tokens of the test, not separators; one
    // right after ]] ends the test and counts as usual.
    if (reading() === 'test' && '()|&<>'.includes(char)) {
      endWord()
      if (test) continue
    }
    const now = reading()
    if (char === '<' || char === '>') {
      if (now !== 'commands') return null
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
    const top = cases.at(-1)
    if (char === '(') {
      // The ( a pattern list may open with; a group inside a pattern is
      // read differently by bash and zsh.
      if (now === 'patterns') {
        if (top && !top.started && parts.length === 0) continue
        return null
      }
      if (now === 'array') return null
      if (parts.length > 0) {
        const before = parts.map((part) => part.text).join('')
        // name() defines a function.
        if (next === ')') {
          endWord()
          endCommand()
          continue
        }
        // name=( sets an array.
        if (
          parts.every((part) => !part.quoted) &&
          /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(before)
        ) {
          endWord()
          array = true
          continue
        }
        // A zsh glob, an extended pattern or zsh's =(...).
        return null
      }
      endWord()
      endCommand()
      continue
    }
    if (char === ')') {
      endWord()
      if (now === 'patterns' && top) top.at = 'body'
      else if (now === 'array') array = false
      else endCommand()
      continue
    }
    if (char === '|' || char === '&') {
      endWord()
      if (now === 'patterns' && char === '|' && top) top.started = true
      else if (now !== 'commands') return null
      else endCommand()
      continue
    }
    if (char === ';') {
      if (now === 'array') return null
      endWord()
      if (now === 'patterns') continue
      test = false
      endCommand()
      // ;; ;& ;;& and zsh's ;| end a pattern's commands.
      const current = cases.at(-1)
      if (current?.at === 'body' && /[;&|]/.test(next)) {
        index += next === ';' && line[index + 2] === '&' ? 2 : 1
        current.at = 'patterns'
        current.started = false
      }
      continue
    }
    if (char === '\n') {
      endWord()
      if (now === 'patterns' || now === 'array') continue
      test = false
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

// Whether a word's text may run as code later: PS4 (traced commands expand
// it), an entry of zsh's function or alias tables, an exported bash
// function, or a substitution, an expansion or a printf escape inside an
// array subscript (bash and zsh evaluate subscripts in arithmetic and in
// builtins such as printf -v, running a $(...) they hold). A [ that closes
// first, as in markdown, does not count.
function runsLater(text: string): boolean {
  if (/^(?:PS4=|BASH_FUNC_)|^(?:functions|aliases|galiases|saliases)(?:\[|\+?=)/.test(text))
    return true
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '[') depth += 1
    else if (char === ']') depth = Math.max(0, depth - 1)
    else if (
      depth > 0 &&
      (char === UNKNOWN ||
        char === '`' ||
        (char === '$' && text[index + 1] === '(') ||
        (char === '\\' && /[xuU0-7]/.test(text[index + 1] ?? '')))
    )
      return true
  }
  return false
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
// null for command substitution, an expansion that may run code or does
// not close.
function expansionEnd(line: string, index: number): number | null {
  let at = index + 1
  const sigil = line[at] ?? ''
  const named = /[A-Za-z_{]/.test(line[at + 1] ?? '')
  // zsh's $~name globs its value, and a glob qualifier can run code.
  if (sigil === '~' && named) return null
  // zsh's $=name, $^name and $+name.
  if (/[=^+]/.test(sigil) && named) at += 1
  const next = line[at] ?? ''
  if (next === '(') return line[at + 1] === '(' ? arithmeticEnd(line, at) : null
  if (next === '{') return braceEnd(line, at)
  if (next === '[') {
    // $[...], old arithmetic.
    const close = line.indexOf(']', at)
    if (close < 0 || /[`'"\\[]|\$\(/.test(line.slice(at + 1, close))) return null
    return close + 1
  }
  if (/[A-Za-z_]/.test(next)) {
    while (/[A-Za-z0-9_]/.test(line[at] ?? '')) at += 1
    return at
  }
  if (/[0-9@*#?$!-]/.test(next)) return at + 1
  return index + 1
}

// Where ${...} ends. Its insides are read only as far as needed: a brace
// or a quote inside (which bash and zsh count differently), zsh's (flags)
// and ~, bash's @P prompt expansion and ${ cmd; } run code or could, so
// any of them makes the line unknown.
function braceEnd(line: string, open: number): number | null {
  if (/[\s|(~]/.test(line[open + 1] ?? '')) return null
  for (let scan = open + 1; scan < line.length; scan += 1) {
    const char = line[scan] ?? ''
    if (char === '\\') scan += 1
    else if (char === '}') return line.slice(open + 1, scan).includes('@P') ? null : scan + 1
    else if ('{\'"`'.includes(char) || (char === '$' && line[scan + 1] === '(')) return null
  }
  return null
}

// Where $((...)) ends; null when it is a command substitution after all
// ($((cmd)|(cmd)) closes its first group early) or holds what could run a
// command (a substitution, quotes, an array subscript, | & < > that may
// belong to a command).
function arithmeticEnd(line: string, open: number): number | null {
  let depth = 0
  for (let scan = open; scan < line.length; scan += 1) {
    const char = line[scan] ?? ''
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 1) {
        if (line[scan + 1] !== ')') return null
        return /[`'"\\[;\n|&<>]|\$\(/.test(line.slice(open + 2, scan)) ? null : scan + 2
      }
    }
  }
  return null
}
