import type { Dialect } from './sql-dialect.ts'

export type TextScan = {
  /** The reason to reject, or null. */
  readonly problem: string | null
  /** PostgreSQL only: names written in double quotes, and bare words, for case folding. */
  readonly quoted: ReadonlySet<string>
  readonly bare: ReadonlySet<string>
}

/**
 * The text layer shared by the read and write guards. String literals are skipped.
 * - MySQL: finds comment constructs that MySQL executes but node-sql-parser reads as comments
 *   (executable comments, optimizer hints, "--x").
 * - PostgreSQL: understands dollar-quoted strings, and rejects nested comments and backslashes in
 *   strings (PostgreSQL and the parser could disagree on where code is).
 */
export const scanText = (sql: string, dialect: Dialect): TextScan => {
  const quoted = new Set<string>()
  const bare = new Set<string>()
  const done = (problem: string | null): TextScan => ({ problem, quoted, bare })
  let i = 0
  while (i < sql.length) {
    const char = sql[i] ?? ''
    if (dialect === 'postgres') {
      if (char === "'") {
        const end = skipQuoted(sql, i, "'", false)
        // Whether a backslash escapes the quote depends on E'' and the server's
        // standard_conforming_strings; the parser could end the string elsewhere. Fail closed.
        if (sql.slice(i, end).includes('\\')) {
          return done(
            'Backslashes in PostgreSQL string literals are not allowed: use chr(92) or a dollar-quoted string ($$…$$).',
          )
        }
        i = end
        continue
      }
      if (char === '"') {
        const end = skipQuoted(sql, i, '"', false)
        quoted.add(sql.slice(i + 1, end - 1).replaceAll('""', '"'))
        i = end
        continue
      }
      if (char === '$') {
        const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
        if (tag !== null && !isWordChar(sql[i - 1])) {
          const end = sql.indexOf(tag[0], i + tag[0].length)
          i = end === -1 ? sql.length : end + tag[0].length
          continue
        }
      }
      if (char === '/' && sql[i + 1] === '*') {
        const end = sql.indexOf('*/', i + 2)
        const body = sql.slice(i + 2, end === -1 ? sql.length : end)
        if (body.includes('/*')) {
          return done('Nested comments (/* /* */ */) are not allowed: remove the inner comment.')
        }
        i = end === -1 ? sql.length : end + 2
        continue
      }
      if (char === '-' && sql[i + 1] === '-') {
        i = endOfLine(sql, i)
        continue
      }
      if (isWordStart(char) && !isWordChar(sql[i - 1])) {
        let end = i + 1
        while (end < sql.length && isWordChar(sql[end])) end++
        bare.add(sql.slice(i, end))
        i = end
        continue
      }
      i++
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      i = skipQuoted(sql, i, char, char !== '`')
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const marker = sql.slice(i + 2, i + 4)
      if (marker.startsWith('!') || marker === 'M!') {
        return done(
          'MySQL executable comments (/*! … */) are not allowed: they run code the guard cannot see.',
        )
      }
      if (marker.startsWith('+')) {
        return done(
          'Optimizer hints (/*+ … */) are not allowed: they can override the query time limit.',
        )
      }
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      const next = sql[i + 2]
      if (next !== undefined && !/\s/.test(next)) {
        return done(
          'In MySQL "--" only starts a comment when followed by a space; write "- -" for arithmetic or "-- " for a comment.',
        )
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
  return done(null)
}

const isWordStart = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z_]/.test(char)
const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char)

const skipQuoted = (sql: string, start: number, quote: string, backslashes: boolean): number => {
  let i = start + 1
  while (i < sql.length) {
    const char = sql[i]
    if (backslashes && char === '\\') {
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
