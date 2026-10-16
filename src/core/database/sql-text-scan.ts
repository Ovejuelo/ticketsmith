/**
 * The text layer shared by the read and write guards: finds comment constructs that MySQL
 * executes but node-sql-parser reads as comments (executable comments, optimizer hints, "--x").
 * String literals are skipped. Returns the reason to reject, or null.
 */
export const scanText = (sql: string): string | null => {
  let i = 0
  while (i < sql.length) {
    const char = sql[i]
    if (char === "'" || char === '"' || char === '`') {
      i = skipQuoted(sql, i, char)
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const marker = sql.slice(i + 2, i + 4)
      if (marker.startsWith('!') || marker === 'M!') {
        return 'MySQL executable comments (/*! … */) are not allowed: they run code the guard cannot see.'
      }
      if (marker.startsWith('+')) {
        return 'Optimizer hints (/*+ … */) are not allowed: they can override the query time limit.'
      }
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      const next = sql[i + 2]
      if (next !== undefined && !/\s/.test(next)) {
        return 'In MySQL "--" only starts a comment when followed by a space; write "- -" for arithmetic or "-- " for a comment.'
      }
      i = endOfLine(sql, i)
      continue
    }
    if (char === '#') {
      i = endOfLine(sql, i)
      continue
    }
    i++
  }
  return null
}

const skipQuoted = (sql: string, start: number, quote: string): number => {
  let i = start + 1
  while (i < sql.length) {
    const char = sql[i]
    if (quote !== '`' && char === '\\') {
      i += 2
      continue
    }
    if (char === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length // unterminated: the parser will reject it
}

const endOfLine = (sql: string, from: number): number => {
  const newline = sql.indexOf('\n', from)
  return newline === -1 ? sql.length : newline + 1
}
