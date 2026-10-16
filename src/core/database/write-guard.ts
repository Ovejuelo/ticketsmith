import { createRequire } from 'node:module'
import { err, ok, type Result } from '../kernel/index.ts'
import type { TableInfo } from './database.schema.ts'
import type { GuardRejection } from './readonly-guard.ts'
import { scanText } from './sql-text-scan.ts'

// node-sql-parser is CommonJS without named ESM exports; its types do declare `Parser`.
const { Parser } = createRequire(import.meta.url)(
  'node-sql-parser',
) as typeof import('node-sql-parser')
const parser = new Parser()
const PARSER_OPTIONS = { database: 'MySQL' } as const

declare const guardedChange: unique symbol

export type ChangeKind = 'insert' | 'update'

/**
 * A write that passed the guard. Only `guardChange` creates it; `sql` is regenerated from the
 * validated tree, so what runs is exactly what was checked.
 */
export type GuardedChange = {
  readonly sql: string
  readonly kind: ChangeKind
  readonly table: string
  /** From the investigated catalog; the rollback script is keyed by it. */
  readonly primaryKey: readonly string[]
  /** INSERT: the listed columns. UPDATE: the SET columns. */
  readonly columns: readonly string[]
  /** UPDATE only: the regenerated WHERE, reused by the read-only preflight. */
  readonly whereSql: string | null
  /** INSERT only: how many rows VALUES adds. */
  readonly insertRows: number | null
  readonly [guardedChange]: true
}

export type WriteGuardOptions = {
  /** The database's investigated tables (columns and keys). */
  readonly tables: readonly TableInfo[]
}

// Deterministic, side-effect-free functions a change may use. Anything else is rejected.
const ALLOWED_FUNCTIONS = new Set([
  'NOW',
  'CURRENT_TIMESTAMP',
  'UTC_TIMESTAMP',
  'CONCAT',
  'COALESCE',
  'IFNULL',
  'UPPER',
  'LOWER',
  'TRIM',
  'ROUND',
])

const LITERAL_TYPES = new Set([
  'number',
  'single_quote_string',
  'double_quote_string',
  'string',
  'natural_string',
  'hex_string',
  'full_hex_string',
  'bit_string',
  'bool',
  'null',
  'date',
  'datetime',
  'time',
  'timestamp',
])

const reject = (reason: string): Result<never, GuardRejection> => err({ kind: 'rejected', reason })

const field = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined

const functionName = (name: unknown): string => {
  const parts = field(name, 'name')
  if (!Array.isArray(parts)) return typeof name === 'string' ? name.toUpperCase() : ''
  const value = field(parts.at(-1), 'value')
  return typeof value === 'string' ? value.toUpperCase() : ''
}

const quote = (identifier: string): string => `\`${identifier.replaceAll('`', '``')}\``

/**
 * Validates that `sql` is one INSERT … VALUES or one UPDATE … WHERE on one known table with a
 * primary key, and returns the SQL to execute. Fails closed, like the read guard: comment tricks
 * are rejected in the text, the whole tree is walked, and the executed SQL is regenerated.
 * DELETE, REPLACE, DDL, INSERT … SELECT, ON DUPLICATE KEY, subqueries, variables and functions
 * outside a small deterministic allowlist never pass. An UPDATE must pin its rows: its WHERE needs
 * at least one `column = literal` or `column IN (literals)` that every matched row must satisfy.
 */
export const guardChange = (
  sql: string,
  options: WriteGuardOptions,
): Result<GuardedChange, GuardRejection> => {
  if (sql.trim() === '') return reject('Empty change.')
  if (sql.includes('\u0000')) return reject('Changes cannot contain null bytes.')
  const textProblem = scanText(sql)
  if (textProblem !== null) return reject(textProblem)

  let parsed: unknown
  try {
    parsed = parser.astify(sql, PARSER_OPTIONS)
  } catch (error) {
    return reject(`The change could not be parsed as MySQL: ${firstLine(error)}`)
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed]
  if (statements.length !== 1)
    return reject('Send exactly one statement (no ";"-separated batches).')
  const root = statements[0]
  const type = field(root, 'type')
  if (type === 'delete')
    return reject('DELETE is never allowed: propose an UPDATE (e.g. a status) instead.')
  if (type === 'replace')
    return reject('REPLACE is never allowed: it deletes rows. Use INSERT or UPDATE.')
  if (type !== 'insert' && type !== 'update') {
    return reject(
      `Only a single INSERT … VALUES or UPDATE … WHERE is allowed; got ${String(type).toUpperCase()}.`,
    )
  }

  const tables = field(root, 'table')
  if (!Array.isArray(tables) || tables.length !== 1 || field(tables[0], 'join')) {
    return reject('A change touches exactly one table (no joins or multi-table updates).')
  }
  if (field(tables[0], 'db')) return reject('Changes cannot target other databases (db.table).')
  const tableName = String(field(tables[0], 'table'))
  const alias = field(tables[0], 'as')
  const table = options.tables.find((candidate) => candidate.name === tableName)
  if (table === undefined) {
    return reject(`Unknown table "${tableName}": check the name with db_schema.`)
  }
  const primaryKey = table.columns.filter((c) => c.key === 'PRI').map((c) => c.name)
  if (primaryKey.length === 0) {
    return reject(`Table "${tableName}" has no primary key, so no reliable rollback can be built.`)
  }

  if (type === 'insert' && field(field(root, 'values'), 'type') === 'select') {
    return reject('INSERT … SELECT is not allowed: list the values (INSERT … VALUES).')
  }
  const unsafe = findUnsafe(root)
  if (unsafe !== null) return reject(unsafe)

  const known = new Set(table.columns.map((c) => c.name))
  const columnProblem = findUnknownColumn(root, known, [
    tableName,
    typeof alias === 'string' ? alias : '',
  ])
  if (columnProblem !== null)
    return reject(`${columnProblem} in ${tableName}: check it with db_schema.`)

  return type === 'insert'
    ? guardInsert(root, parsed, table, primaryKey)
    : guardUpdate(root, parsed, table, primaryKey)
}

const guardInsert = (
  root: unknown,
  parsed: unknown,
  table: TableInfo,
  primaryKey: readonly string[],
): Result<GuardedChange, GuardRejection> => {
  if (
    String(field(root, 'prefix') ?? '')
      .toLowerCase()
      .includes('ignore')
  ) {
    return reject('INSERT IGNORE is not allowed: it hides errors. Use a plain INSERT.')
  }
  if (field(root, 'on_duplicate_update')) return reject('ON DUPLICATE KEY UPDATE is not allowed.')
  const columns = field(root, 'columns')
  if (!Array.isArray(columns) || columns.length === 0) {
    return reject('INSERT needs an explicit column list: INSERT INTO t (a, b) VALUES (…).')
  }
  const values = field(root, 'values')
  if (field(values, 'type') !== 'values') {
    return reject('INSERT … SELECT is not allowed: list the values (INSERT … VALUES).')
  }
  const rows = field(values, 'values')
  if (!Array.isArray(rows) || rows.length === 0)
    return reject('INSERT needs at least one row of VALUES.')
  for (const row of rows) {
    const items = field(row, 'value')
    if (!Array.isArray(items) || items.length !== columns.length) {
      return reject(
        `The INSERT lists ${columns.length} columns but ${Array.isArray(items) ? items.length : 0} values in a row.`,
      )
    }
    for (const item of items) {
      const problem = valueProblem(item, false)
      if (problem !== null) return reject(problem)
    }
  }
  const names = columns.map(String)
  const regenerated = regenerate(parsed)
  if (!regenerated.ok) return regenerated
  // node-sql-parser leaves INSERT columns unquoted; quote them so reserved words survive.
  const sql = regenerated.value.replace(
    /\(([^()]*)\) VALUES/,
    () => `(${names.map(quote).join(', ')}) VALUES`,
  )
  return ok({
    sql,
    kind: 'insert',
    table: table.name,
    primaryKey,
    columns: names,
    whereSql: null,
    insertRows: rows.length,
  } as unknown as GuardedChange)
}

const guardUpdate = (
  root: unknown,
  parsed: unknown,
  table: TableInfo,
  primaryKey: readonly string[],
): Result<GuardedChange, GuardRejection> => {
  const orderBy = field(root, 'orderby')
  const limit = field(field(root, 'limit'), 'value')
  if (
    (Array.isArray(orderBy) && orderBy.length > 0) ||
    (Array.isArray(limit) && limit.length > 0)
  ) {
    return reject('UPDATE … ORDER BY or LIMIT is not allowed: pin the rows in the WHERE instead.')
  }
  const set = field(root, 'set')
  if (!Array.isArray(set) || set.length === 0)
    return reject('UPDATE needs at least one SET column.')
  for (const item of set) {
    const problem = valueProblem(field(item, 'value'), true)
    if (problem !== null) return reject(problem)
  }
  const where = field(root, 'where')
  if (where === null || where === undefined) {
    return reject('UPDATE needs a WHERE that pins the rows to change (e.g. WHERE id = 7).')
  }
  if (!pinsRows(where)) {
    return reject(
      'The WHERE must pin rows: include at least one "column = literal" or "column IN (literals)" joined with AND (not OR), e.g. WHERE id = 7.',
    )
  }
  const regenerated = regenerate(parsed)
  if (!regenerated.ok) return regenerated
  let whereSql: string
  try {
    whereSql = parser.exprToSQL(where as Parameters<typeof parser.exprToSQL>[0], PARSER_OPTIONS)
  } catch (error) {
    return reject(`The WHERE could not be safely regenerated: ${firstLine(error)}`)
  }
  return ok({
    sql: regenerated.value,
    kind: 'update',
    table: table.name,
    primaryKey,
    columns: set.map((item) => String(field(item, 'column'))),
    whereSql,
    insertRows: null,
  } as unknown as GuardedChange)
}

/** Literals, allowlisted functions of values, and (in SET) arithmetic on the row's own columns. */
const valueProblem = (node: unknown, allowColumns: boolean): string | null => {
  const type = field(node, 'type')
  if (typeof type === 'string' && LITERAL_TYPES.has(type)) return null
  if (type === 'column_ref') return allowColumns ? null : 'INSERT values must be literals.'
  if (type === 'function') {
    const args = field(field(node, 'args'), 'value')
    for (const arg of Array.isArray(args) ? args : []) {
      const problem = valueProblem(arg, allowColumns)
      if (problem !== null) return problem
    }
    return null // the name was already checked by findUnsafe
  }
  if (type === 'unary_expr') return valueProblem(field(node, 'expr'), allowColumns)
  if (type === 'binary_expr' && ['+', '-', '*', '/'].includes(String(field(node, 'operator')))) {
    return (
      valueProblem(field(node, 'left'), allowColumns) ??
      valueProblem(field(node, 'right'), allowColumns)
    )
  }
  return `Unsupported value expression (${String(type)}): use literals${allowColumns ? ', columns' : ''} or simple functions.`
}

const isLiteral = (node: unknown): boolean => {
  const type = field(node, 'type')
  if (type === 'null' || type === 'bool') return false // `= NULL` matches nothing; TRUE pins nothing
  return typeof type === 'string' && LITERAL_TYPES.has(type)
}

/** True when an AND-only path holds `column = literal` or `column IN (literals…)`. */
const pinsRows = (node: unknown): boolean => {
  if (field(node, 'type') !== 'binary_expr') return false
  const operator = String(field(node, 'operator')).toUpperCase()
  const left = field(node, 'left')
  const right = field(node, 'right')
  if (operator === 'AND') return pinsRows(left) || pinsRows(right)
  if (operator === '=') {
    return (
      (field(left, 'type') === 'column_ref' && isLiteral(right)) ||
      (field(right, 'type') === 'column_ref' && isLiteral(left))
    )
  }
  if (operator === 'IN') {
    const values = field(right, 'value')
    return (
      field(left, 'type') === 'column_ref' &&
      field(right, 'type') === 'expr_list' &&
      Array.isArray(values) &&
      values.length > 0 &&
      values.every(isLiteral)
    )
  }
  return false
}

/** Subqueries, variables, assignments and functions outside the allowlist, anywhere in the tree. */
const findUnsafe = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUnsafe(item)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const type = field(node, 'type')
  if (type === 'select' || field(node, 'ast') !== undefined) {
    return 'Subqueries are not allowed in changes: look the values up with db_select first.'
  }
  if (type === 'var') return 'Session variables (@x, @@x) are not allowed in changes.'
  if (type === 'assign') return 'Variable assignment (:=) is not allowed in changes.'
  if (type === 'aggr_func') return 'Aggregate functions are not allowed in changes.'
  if (type === 'function') {
    const name = functionName(field(node, 'name'))
    if (!ALLOWED_FUNCTIONS.has(name)) {
      return `${name}() is not allowed in changes; allowed: ${[...ALLOWED_FUNCTIONS].join(', ')}.`
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'table') continue // the target table list, checked separately
    const found = findUnsafe(value)
    if (found !== null) return found
  }
  return null
}

/** Every column the change names must exist in the table (qualified only by the table or alias). */
const findUnknownColumn = (
  root: unknown,
  known: ReadonlySet<string>,
  qualifiers: readonly string[],
): string | null => {
  const names: string[] = []
  const insertColumns = field(root, 'columns')
  if (field(root, 'type') === 'insert' && Array.isArray(insertColumns))
    names.push(...insertColumns.map(String))
  const set = field(root, 'set')
  if (Array.isArray(set)) names.push(...set.map((item) => String(field(item, 'column'))))
  const collect = (node: unknown): string | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = collect(item)
        if (found !== null) return found
      }
      return null
    }
    if (node === null || typeof node !== 'object') return null
    if (field(node, 'type') === 'column_ref') {
      const qualifier = field(node, 'table')
      if (typeof qualifier === 'string' && qualifier !== '' && !qualifiers.includes(qualifier)) {
        return `Unknown table qualifier "${qualifier}"`
      }
      names.push(String(field(node, 'column')))
      return null
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'table' || key === 'columns') continue
      const found = collect(value)
      if (found !== null) return found
    }
    return null
  }
  const qualifierProblem = collect({ set: field(root, 'set'), where: field(root, 'where') })
  if (qualifierProblem !== null) return qualifierProblem
  const unknown = names.find((name) => !known.has(name))
  return unknown === undefined ? null : `Unknown column "${unknown}"`
}

const regenerate = (parsed: unknown): Result<string, GuardRejection> => {
  try {
    return ok(parser.sqlify(parsed as Parameters<typeof parser.sqlify>[0], PARSER_OPTIONS).trim())
  } catch (error) {
    return reject(`The change could not be safely regenerated: ${firstLine(error)}`)
  }
}

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
