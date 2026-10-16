import { createRequire } from 'node:module'
import { err, ok, type Result } from '../kernel/index.ts'

// node-sql-parser is CommonJS without named ESM exports; its types do declare `Parser`.
const { Parser } = createRequire(import.meta.url)(
  'node-sql-parser',
) as typeof import('node-sql-parser')
const parser = new Parser()

export type Dialect = 'mysql'

declare const guarded: unique symbol

/**
 * A read query that passed the guard. Only `guardReadQuery` creates it, so adapters that accept a
 * GuardedQuery cannot be handed raw SQL. `sql` is regenerated from the validated syntax tree.
 */
export type GuardedQuery = {
  readonly sql: string
  /** Rows the caller may show; the SQL asks for one more to detect truncation. */
  readonly maxRows: number
  readonly [guarded]: true
}

export type GuardRejection = { readonly kind: 'rejected'; readonly reason: string }

export type GuardOptions = { readonly dialect: Dialect; readonly maxRows: number }

const PARSER_OPTIONS = { database: 'MySQL' } as const

// Functions that wait, lock, read server files or run commands. Writes are also stopped by the
// READ ONLY transaction; these are blocked because they misuse a read connection.
const DENIED_FUNCTIONS = new Set([
  'SLEEP',
  'BENCHMARK',
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'IS_FREE_LOCK',
  'IS_USED_LOCK',
  'LOAD_FILE',
  'SYS_EXEC',
  'SYS_EVAL',
  'MASTER_POS_WAIT',
  'SOURCE_POS_WAIT',
  'WAIT_FOR_EXECUTED_GTID_SET',
  'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS',
])

const reject = (reason: string): Result<never, GuardRejection> => err({ kind: 'rejected', reason })

/**
 * Validates that `sql` is a single side-effect-free SELECT and returns the SQL to execute.
 * Fails closed: anything it cannot parse or understand is rejected. Two layers:
 * 1. Text scan for comment tricks the parser cannot see but MySQL executes (/*! … *\/, "--x").
 * 2. Full syntax-tree walk; the executed SQL is regenerated from that tree, so what runs is
 *    exactly what was checked.
 * Defense in depth still applies at execution time (READ ONLY transaction, time limit, ROLLBACK).
 */
export const guardReadQuery = (
  sql: string,
  options: GuardOptions,
): Result<GuardedQuery, GuardRejection> => {
  if (sql.trim() === '') return reject('Empty query.')
  if (sql.includes('\u0000')) return reject('Queries cannot contain null bytes.')

  const textProblem = scanText(sql)
  if (textProblem !== null) return reject(textProblem)

  let parsed: unknown
  try {
    parsed = parser.astify(sql, PARSER_OPTIONS)
  } catch (error) {
    return reject(`The query could not be parsed as MySQL: ${firstLine(error)}`)
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed]
  if (statements.length !== 1) {
    return reject('Send exactly one statement (no ";"-separated batches).')
  }
  const root = statements[0]
  const rootType = field(root, 'type')
  if (rootType !== 'select') {
    return reject(
      `Only a single SELECT (or WITH … SELECT) is allowed; got ${String(rootType).toUpperCase()}.`,
    )
  }

  const violation = findViolation(root)
  if (violation !== null) return reject(violation)

  const existingLimit = limitOf(root)
  if (existingLimit === 'unreadable') {
    return reject('LIMIT must be a plain number (no parameters or expressions).')
  }
  if (existingLimit !== null && existingLimit > options.maxRows) {
    return reject(
      `LIMIT ${existingLimit} is above the maximum of ${options.maxRows} rows; use LIMIT ${options.maxRows} or less.`,
    )
  }

  let regenerated: string
  try {
    regenerated = parser
      .sqlify(parsed as Parameters<typeof parser.sqlify>[0], PARSER_OPTIONS)
      .trim()
  } catch (error) {
    return reject(`The query could not be safely regenerated: ${firstLine(error)}`)
  }
  const executable =
    existingLimit === null ? `${regenerated} LIMIT ${options.maxRows + 1}` : regenerated
  return ok({ sql: executable, maxRows: options.maxRows } as GuardedQuery)
}

// --- text layer ----------------------------------------------------------------------------

/** Finds comment constructs that MySQL and the parser read differently; skips string literals. */
const scanText = (sql: string): string | null => {
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

// --- tree layer ----------------------------------------------------------------------------

const field = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined

const functionName = (name: unknown): string => {
  if (typeof name === 'string') return name.toUpperCase()
  const parts = field(name, 'name')
  if (!Array.isArray(parts)) return ''
  const last = parts.at(-1)
  const value = field(last, 'value')
  return typeof value === 'string' ? value.toUpperCase() : ''
}

/** Walks every node (subqueries, CTEs, UNION branches) and returns the first reason to reject. */
const findViolation = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findViolation(item)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null

  const type = field(node, 'type')
  if (type === 'assign') return 'Variable assignment (:=) is not allowed in read queries.'
  if (type === 'var') return 'Session variables (@x, @@x) are not allowed in read queries.'
  if (type === 'function') {
    const name = functionName(field(node, 'name'))
    if (DENIED_FUNCTIONS.has(name)) return `${name}() is not allowed in read queries.`
  }
  if (typeof type === 'string' && type !== 'select' && STATEMENT_TYPES.has(type)) {
    return `Nested ${type.toUpperCase()} statements are not allowed.`
  }

  const into = field(node, 'into')
  if (field(into, 'position') || field(into, 'keyword')) {
    return 'SELECT … INTO (files or variables) is not allowed.'
  }
  if (field(node, 'locking_read')) {
    return 'Locking reads (FOR UPDATE, FOR SHARE, LOCK IN SHARE MODE) are not allowed.'
  }

  for (const value of Object.values(node)) {
    const found = findViolation(value)
    if (found !== null) return found
  }
  return null
}

const STATEMENT_TYPES = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'replace',
  'create',
  'drop',
  'alter',
  'truncate',
  'rename',
  'set',
  'call',
  'load_data',
  'grant',
  'lock',
  'unlock',
  'show',
  'explain',
  'use',
])

/** The row count of the outermost LIMIT (the last UNION branch carries it), if any. */
const limitOf = (root: unknown): number | null | 'unreadable' => {
  let node: unknown = root
  let limit = field(root, 'limit')
  while (field(node, '_next') !== undefined && field(node, '_next') !== null) {
    node = field(node, '_next')
    const branchLimit = field(node, 'limit')
    if (
      Array.isArray(field(branchLimit, 'value')) &&
      (field(branchLimit, 'value') as unknown[]).length > 0
    ) {
      limit = branchLimit
    }
  }
  const values = field(limit, 'value')
  if (!Array.isArray(values) || values.length === 0) return null
  const countNode = field(limit, 'seperator') === ',' ? values[1] : values[0]
  const count = field(countNode, 'value')
  return field(countNode, 'type') === 'number' && typeof count === 'number' ? count : 'unreadable'
}

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
