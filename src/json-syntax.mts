// Why a config's JSON did not parse, quoting none of it: JSON.parse quotes
// the text around a syntax error (`Unexpected token 'x', ..."ls": [x, "y"]"...
// is not valid JSON`), which may hold a credential, so keep what comes before
// the quote. Its other messages give a position and quote nothing.
export function jsonSyntaxReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
  const quote = message.indexOf('"')
  const reason = (quote < 0 ? message : message.slice(0, quote)).replace(/[\s,.]+$/, '')
  return reason || 'not valid JSON'
}
