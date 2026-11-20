// Text with wildcards on both sides, for permission rules (see
// ask-rules.mts): a rule's * and what a shell works out when it runs
// (shell-commands.mts) are both UNKNOWN.

// Any text, spaces and slashes included. A command line, a host or a tool
// name never holds this character.
export const UNKNOWN = '\u0000'

// Whether some text fits both `a` and `b`, in time linear in each.
export function mayMatch(a: string, b: string): boolean {
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
  // Too long to compare: assume they fit.
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
