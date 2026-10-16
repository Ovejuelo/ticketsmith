import { createPool } from 'mysql2/promise'
import { z } from 'zod'
import { err, type Logger, ok, type Result } from '../../../kernel/index.ts'
import type { DatabaseSchema, TableInfo } from '../../database.schema.ts'
import type { DatabaseAdapter, DatabaseError, QueryResult } from '../../database-adapter.port.ts'
import type { GuardedQuery } from '../../readonly-guard.ts'

/** The slice of a mysql2 pool connection this adapter uses; tests provide a fake. */
export type MysqlConnection = {
  query(options: { readonly sql: string; readonly timeout?: number }): Promise<[unknown, unknown]>
  release(): void
}

export type MysqlConnectionSource = {
  getConnection(): Promise<MysqlConnection>
  end(): Promise<void>
}

export type MysqlConnectionConfig = {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string
  readonly ssl: boolean
}

export type MysqlAdapterOptions = {
  readonly name: string
  readonly source: MysqlConnectionSource
  readonly logger: Logger
  /** Per-query limit enforced by MySQL (MAX_EXECUTION_TIME) and, with a margin, by the client. */
  readonly timeoutMs?: number
  readonly clock?: () => number
}

const DEFAULT_TIMEOUT_MS = 15_000
const CLIENT_TIMEOUT_MARGIN_MS = 2_000

/** A small pool with settings that keep reads predictable; multi-statement batches are refused. */
export const createMysqlConnectionSource = (config: MysqlConnectionConfig): MysqlConnectionSource =>
  createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ...(config.ssl ? { ssl: {} } : {}),
    connectionLimit: 2,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10_000,
  }) as unknown as MysqlConnectionSource

export class MysqlDatabaseAdapter implements DatabaseAdapter {
  readonly name: string
  readonly dialect = 'mysql'
  readonly #source: MysqlConnectionSource
  readonly #logger: Logger
  readonly #timeoutMs: number
  readonly #clock: () => number

  constructor(options: MysqlAdapterOptions) {
    this.name = options.name
    this.#source = options.source
    this.#logger = options.logger
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#clock = options.clock ?? Date.now
  }

  async runReadQuery(query: GuardedQuery): Promise<Result<QueryResult, DatabaseError>> {
    const started = this.#clock()
    const result = await this.#readOnly(async (run) => {
      const [rows, fields] = await run(query.sql)
      return { rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [], fields }
    })
    if (!result.ok) return result
    const { rows, fields } = result.value
    return ok({
      columns: columnNames(fields, rows),
      rows: rows.slice(0, query.maxRows),
      truncated: rows.length > query.maxRows,
      elapsedMs: this.#clock() - started,
    })
  }

  async ping(): Promise<Result<void, DatabaseError>> {
    const result = await this.#readOnly((run) => run('SELECT 1'))
    return result.ok ? ok(undefined) : result
  }

  async accountCanWrite(): Promise<Result<boolean, DatabaseError>> {
    const result = await this.#readOnly((run) => run('SHOW GRANTS FOR CURRENT_USER()'))
    if (!result.ok) return result
    const [rows] = result.value
    const grants = (Array.isArray(rows) ? rows : []).flatMap((row) =>
      Object.values(row as Record<string, unknown>).map(String),
    )
    return ok(grants.some(grantsWrite))
  }

  async introspect(): Promise<Result<DatabaseSchema, DatabaseError>> {
    const result = await this.#readOnly(async (run) => ({
      tables: (await run(TABLES_SQL))[0],
      columns: (await run(COLUMNS_SQL))[0],
      foreignKeys: (await run(FOREIGN_KEYS_SQL))[0],
      indexes: (await run(INDEXES_SQL))[0],
    }))
    if (!result.ok) return result
    const parsed = IntrospectionSchema.safeParse(result.value)
    if (!parsed.success) {
      return err({
        kind: 'query',
        database: this.name,
        message: `Unexpected schema rows: ${z.prettifyError(parsed.error)}`,
      })
    }
    return ok({ tables: assembleTables(parsed.data) })
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#source.end()
  }

  /**
   * Every statement runs in a read-only session, inside a READ ONLY transaction with a server-side
   * time limit, and the transaction is always rolled back, so even a write or DDL that slipped past
   * the guard is refused by MySQL and never committed.
   */
  async #readOnly<T>(
    work: (run: (sql: string) => Promise<[unknown, unknown]>) => Promise<T>,
  ): Promise<Result<T, DatabaseError>> {
    let connection: MysqlConnection
    try {
      connection = await this.#source.getConnection()
    } catch (error) {
      return err(this.#mapError(error))
    }
    const run = (sql: string) =>
      connection.query({ sql, timeout: this.#timeoutMs + CLIENT_TIMEOUT_MARGIN_MS })
    try {
      // The session must be read-only too: START TRANSACTION READ ONLY alone does not stop DDL,
      // because DDL commits implicitly and runs outside the transaction (verified on MySQL 8.0 and 8.4.9).
      // MySQL lets a session switch this off again, so it is re-applied on every call, and each
      // call runs exactly one caller statement (no batches): a switch-off cannot reach a write.
      await run(
        `SET SESSION MAX_EXECUTION_TIME = ${Math.floor(this.#timeoutMs)}, transaction_read_only = ON`,
      )
      await run('START TRANSACTION READ ONLY')
      return ok(await work(run))
    } catch (error) {
      return err(this.#mapError(error))
    } finally {
      try {
        await run('ROLLBACK')
      } catch (error) {
        this.#logger.warn({ database: this.name, error: String(error) }, 'rollback failed')
      }
      connection.release()
    }
  }

  #mapError(error: unknown): DatabaseError {
    const code = typeof field(error, 'code') === 'string' ? (field(error, 'code') as string) : ''
    const errno = typeof field(error, 'errno') === 'number' ? (field(error, 'errno') as number) : 0
    const message = error instanceof Error ? error.message : String(error)
    const database = this.name
    if (UNREACHABLE_CODES.has(code)) return { kind: 'unreachable', database, message: code }
    if (errno === 1045 || errno === 1044) return { kind: 'auth', database, message }
    if (errno === 3024 || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
      return { kind: 'timeout', database, seconds: Math.round(this.#timeoutMs / 1000) }
    }
    if (errno === 1792) return { kind: 'rejected-by-database', database, message }
    return { kind: 'query', database, message }
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
])

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

const columnNames = (fields: unknown, rows: readonly Record<string, unknown>[]): string[] => {
  if (Array.isArray(fields)) {
    const names = fields
      .map((f) => field(f, 'name'))
      .filter((n): n is string => typeof n === 'string')
    if (names.length > 0) return names
  }
  return rows[0] === undefined ? [] : Object.keys(rows[0])
}

const WRITE_PRIVILEGES =
  /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE)\b/i

const grantsWrite = (grant: string): boolean =>
  /^GRANT\b/i.test(grant) &&
  !/^GRANT USAGE\b/i.test(grant) &&
  WRITE_PRIVILEGES.test(grant.split(/\bON\b/i)[0] ?? '')

// Constant, parameter-free SQL against information_schema for the connection's own database.
const TABLES_SQL = `SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment, TABLE_ROWS AS table_rows
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
const COLUMNS_SQL = `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
  IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key, COLUMN_DEFAULT AS column_default,
  COLUMN_COMMENT AS column_comment
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, ORDINAL_POSITION`
const FOREIGN_KEYS_SQL = `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
  REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
const INDEXES_SQL = `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
  COLUMN_NAME AS column_name
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`

const text = z.union([z.string(), z.null()]).transform((value) => value ?? '')
const IntrospectionSchema = z.object({
  tables: z.array(
    z.object({
      table_name: z.string(),
      table_comment: text,
      table_rows: z.union([z.number(), z.string(), z.null()]),
    }),
  ),
  columns: z.array(
    z.object({
      table_name: z.string(),
      column_name: z.string(),
      column_type: z.string(),
      is_nullable: z.string(),
      column_key: text,
      column_default: z.string().nullable(),
      column_comment: text,
    }),
  ),
  foreignKeys: z.array(
    z.object({
      table_name: z.string(),
      column_name: z.string(),
      referenced_table: z.string(),
      referenced_column: z.string(),
    }),
  ),
  indexes: z.array(
    z.object({
      table_name: z.string(),
      index_name: z.string(),
      non_unique: z.union([z.number(), z.string()]),
      column_name: z.string().nullable(),
    }),
  ),
})

const assembleTables = (rows: z.infer<typeof IntrospectionSchema>): TableInfo[] =>
  rows.tables
    .map((table) => {
      const indexes = new Map<string, { columns: string[]; unique: boolean }>()
      for (const row of rows.indexes.filter((r) => r.table_name === table.table_name)) {
        const entry = indexes.get(row.index_name) ?? {
          columns: [],
          unique: Number(row.non_unique) === 0,
        }
        if (row.column_name !== null) entry.columns.push(row.column_name)
        indexes.set(row.index_name, entry)
      }
      return {
        name: table.table_name,
        comment: table.table_comment,
        estimatedRows: table.table_rows === null ? null : Number(table.table_rows),
        columns: rows.columns
          .filter((c) => c.table_name === table.table_name)
          .map((c) => ({
            name: c.column_name,
            type: c.column_type,
            nullable: c.is_nullable === 'YES',
            key: c.column_key,
            default: c.column_default,
            comment: c.column_comment,
          })),
        foreignKeys: rows.foreignKeys
          .filter((fk) => fk.table_name === table.table_name)
          .map((fk) => ({
            column: fk.column_name,
            referencesTable: fk.referenced_table,
            referencesColumn: fk.referenced_column,
          })),
        indexes: [...indexes].map(([name, index]) => ({ name, ...index })),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
