import type { Dialect } from './sql-dialect.ts'

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

/**
 * A value as literal text, for generated scripts (rollback.sql). MySQL strings are escaped like
 * mysql2 does; PostgreSQL strings are standard-conforming ('' doubles a quote, backslashes are
 * plain characters).
 */
export const sqlLiteral = (value: unknown, dialect: Dialect = 'mysql'): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') {
    if (dialect === 'postgres') return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex')
    return dialect === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`
  }
  if (value instanceof Date) return `'${value.toISOString()}'`
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (dialect === 'postgres') return `'${text.replaceAll("'", "''")}'`
  let escaped = ''
  for (const char of text) escaped += ESCAPES[char] ?? char
  return `'${escaped}'`
}

export const quoteIdentifier = (identifier: string, dialect: Dialect = 'mysql'): string =>
  dialect === 'postgres'
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll('`', '``')}\``
