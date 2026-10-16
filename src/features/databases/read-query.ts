import {
  type DatabaseAdapter,
  describeDatabaseError,
  guardReadQuery,
  type QueryResult,
} from '../../core/database/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import type { DatabaseConnections } from '../../core/services/index.ts'

export const DEFAULT_ROWS = 200
export const MAX_ROWS = 1000
const GROUP_CONCURRENCY = 3
const MAX_CELL = 300

export type DatabaseAnswer = {
  readonly database: string
  readonly result: Result<QueryResult, string>
}

/** Guard, connect and run one read on one database. */
export const readOne = async (
  connections: DatabaseConnections,
  database: string,
  sql: string,
  maxRows: number,
): Promise<Result<QueryResult, string>> => {
  const guarded = guardReadQuery(sql, { dialect: 'mysql', maxRows })
  if (!guarded.ok) return err(`Query rejected: ${guarded.error.reason}`)
  if (!connections.configs.some((config) => config.name === database)) {
    const target = connections.resolveTarget(database)
    return err(
      target.ok
        ? `"${database}" is a group; use db_select_group (CLI: --group) or pick one of: ${target.value.map((m) => m.name).join(', ')}.`
        : target.error,
    )
  }
  const adapter = await connections.connect(database)
  if (!adapter.ok) return adapter
  return run(adapter.value, guarded.value)
}

/** Runs the same guarded read on every database of a group (bounded concurrency); one failing database never hides the others. */
export const readGroup = async (
  connections: DatabaseConnections,
  group: string,
  sql: string,
  maxRows: number,
): Promise<Result<readonly DatabaseAnswer[], string>> => {
  const guarded = guardReadQuery(sql, { dialect: 'mysql', maxRows })
  if (!guarded.ok) return err(`Query rejected: ${guarded.error.reason}`)
  const members = connections.resolveTarget(group)
  if (!members.ok) return members

  const answers: DatabaseAnswer[] = new Array(members.value.length)
  let next = 0
  const worker = async () => {
    while (next < members.value.length) {
      const index = next++
      const member = members.value[index]
      if (member === undefined) return
      const adapter = await connections.connect(member.name)
      answers[index] = {
        database: member.name,
        result: adapter.ok ? await run(adapter.value, guarded.value) : adapter,
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(GROUP_CONCURRENCY, members.value.length) }, worker),
  )
  return ok(answers)
}

const run = async (
  adapter: DatabaseAdapter,
  query: Parameters<DatabaseAdapter['runReadQuery']>[0],
): Promise<Result<QueryResult, string>> => {
  const result = await adapter.runReadQuery(query)
  return result.ok ? result : err(describeDatabaseError(result.error))
}

const cell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? 'NULL'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  const flat = text.replace(/\s+/g, ' ').replaceAll('|', '\\|')
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat
}

export const renderMarkdownTable = (result: QueryResult): string => {
  if (result.rows.length === 0) return '_No rows._'
  return [
    `| ${result.columns.join(' | ')} |`,
    `| ${result.columns.map(() => '---').join(' | ')} |`,
    ...result.rows.map(
      (row) => `| ${result.columns.map((column) => cell(row[column])).join(' | ')} |`,
    ),
  ].join('\n')
}

export const renderFooter = (database: string, result: QueryResult): string =>
  `${result.rows.length} row(s) from ${database} in ${result.elapsedMs} ms${
    result.truncated ? ' · truncated: more rows match, add filters or lower the LIMIT' : ''
  }`
