// Characters MySQL string literals escape (as mysql2 does), keyed by the character itself.
const ESCAPES: Readonly<Record<string, string>> = {
  [String.fromCharCode(0)]: '\\0',
  [String.fromCharCode(8)]: '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  [String.fromCharCode(26)]: '\\Z',
  '"': '\\"',
  "'": "\\'",
  '\\': '\\\\',
}

/** A value as MySQL literal text, for generated scripts (rollback.sql), escaped like mysql2 does. */
export const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let escaped = ''
  for (const char of text) escaped += ESCAPES[char] ?? char
  return `'${escaped}'`
}

export const quoteIdentifier = (identifier: string): string =>
  `\`${identifier.replaceAll('`', '``')}\``
