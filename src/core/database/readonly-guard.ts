import { err, ok, type Result } from '../kernel/index.ts'
import {
  astify,
  DIALECT_LABEL,
  type Dialect,
  field,
  foldPostgresNames,
  isDollarString,
  sqlify,
} from './sql-dialect.ts'
import { scanText } from './sql-text-scan.ts'

export type { Dialect } from './sql-dialect.ts'

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

// Functions that wait, lock, read server files, run SQL text or commands. Writes are also stopped
// by the READ ONLY transaction; these are blocked because they misuse a read connection.
const MYSQL_DENIED = new Set([
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

const POSTGRES_DENIED = new Set([
  'SET_CONFIG',
  'NEXTVAL',
  'SETVAL',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_NOTIFY',
  'PG_LOGICAL_EMIT_MESSAGE',
  'PG_PROMOTE',
  'PG_IMPORT_SYSTEM_COLLATIONS',
  // These run SQL passed as text, which the guard never sees.
  'QUERY_TO_XML',
  'QUERY_TO_XMLSCHEMA',
  'QUERY_TO_XML_AND_XMLSCHEMA',
  'CURSOR_TO_XML',
  'CURSOR_TO_XMLSCHEMA',
  'TS_STAT',
])

const POSTGRES_DENIED_PREFIXES = [
  'PG_SLEEP', // pg_sleep, pg_sleep_for, pg_sleep_until
  'PG_READ_', // pg_read_file, pg_read_binary_file
  'PG_LS_', // pg_ls_dir, pg_ls_logdir, pg_ls_waldir…
  'PG_STAT_FILE',
  'PG_STAT_RESET',
  'PG_FILE_',
  'LO_', // large objects: lo_import, lo_export…
  'DBLINK',
  'PG_ADVISORY_',
  'PG_TRY_ADVISORY_',
  'TXID_',
  'PG_CREATE_',
  'PG_DROP_',
  'PG_REPLICATION_',
  'PG_WAL_',
  'PG_SWITCH_WAL',
]

const isDenied = (name: string, dialect: Dialect): boolean =>
  dialect === 'mysql'
    ? MYSQL_DENIED.has(name)
    : POSTGRES_DENIED.has(name) ||
      POSTGRES_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))

const reject = (reason: string): Result<never, GuardRejection> => err({ kind: 'rejected', reason })

/**
 * Validates that `sql` is a single side-effect-free SELECT and returns the SQL to execute.
 * Fails closed: anything it cannot parse or understand is rejected. Two layers:
 * 1. Text scan for constructs the parser and the database would read differently (MySQL
 *    executable comments and "--x"; PostgreSQL nested comments and backslashes in strings).
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

  const { dialect } = options
  const text = scanText(sql, dialect)
  if (text.problem !== null) return reject(text.problem)

  let parsed: unknown
  try {
    parsed = astify(sql, dialect)
  } catch (error) {
    return reject(`The query could not be parsed as ${DIALECT_LABEL[dialect]}: ${firstLine(error)}`)
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

  const violation = findViolation(root, dialect)
  if (violation !== null) return reject(violation)
  if (dialect === 'postgres') {
    const ambiguous = foldPostgresNames(parsed, text.quoted, text.bare)
    if (ambiguous !== null) return reject(ambiguous)
  }

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
    regenerated = sqlify(parsed, dialect)
  } catch (error) {
    return reject(`The query could not be safely regenerated: ${firstLine(error)}`)
  }
  const executable =
    existingLimit === null ? `${regenerated} LIMIT ${options.maxRows + 1}` : regenerated
  return ok({ sql: executable, maxRows: options.maxRows } as GuardedQuery)
}

// --- tree layer ----------------------------------------------------------------------------

const functionName = (name: unknown): string => {
  if (typeof name === 'string') return name.toUpperCase()
  const parts = field(name, 'name')
  if (!Array.isArray(parts)) return ''
  const last = parts.at(-1)
  const value = field(last, 'value')
  return typeof value === 'string' ? value.toUpperCase() : ''
}

/** Walks every node (subqueries, CTEs, UNION branches) and returns the first reason to reject. */
const findViolation = (node: unknown, dialect: Dialect): string | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findViolation(item, dialect)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null

  const type = field(node, 'type')
  if (type === 'assign') return 'Variable assignment (:=) is not allowed in read queries.'
  if (type === 'var') {
    if (dialect === 'postgres' && isDollarString(node)) return null
    return dialect === 'postgres'
      ? 'Parameters ($1) are not allowed in read queries: write the values.'
      : 'Session variables (@x, @@x) are not allowed in read queries.'
  }
  if (type === 'function') {
    const name = functionName(field(node, 'name'))
    if (isDenied(name, dialect)) return `${name}() is not allowed in read queries.`
  }
  if (typeof type === 'string' && type !== 'select' && STATEMENT_TYPES.has(type)) {
    return `Nested ${type.toUpperCase()} statements are not allowed.`
  }

  const into = field(node, 'into')
  if (field(into, 'position') || field(into, 'keyword')) {
    return 'SELECT … INTO (files, variables or new tables) is not allowed.'
  }
  if (field(node, 'locking_read')) {
    return 'Locking reads (FOR UPDATE, FOR SHARE, LOCK IN SHARE MODE) are not allowed.'
  }

  for (const value of Object.values(node)) {
    const found = findViolation(value, dialect)
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
