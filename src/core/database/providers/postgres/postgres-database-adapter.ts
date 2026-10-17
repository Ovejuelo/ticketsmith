import pg from 'pg'
import { z } from 'zod'
import { err, type Logger, ok, type Result } from '../../../kernel/index.ts'
import type { DatabaseSchema } from '../../database.schema.ts'
import type {
  ApprovedChange,
  ChangeError,
  ChangeOutcome,
  DatabaseAdapter,
  DatabaseError,
  QueryResult,
} from '../../database-adapter.port.ts'
import { assembleTables, IntrospectionSchema } from '../../introspection.ts'
import type { GuardedQuery } from '../../readonly-guard.ts'
import { quoteIdentifier } from '../../sql-literal.ts'

export type PostgresQueryResult = {
  readonly rows: readonly Record<string, unknown>[]
  readonly fields: readonly { readonly name: string }[]
  readonly rowCount: number | null
}

/**
 * The slice of a pg pool client this adapter uses; tests provide a fake. `extended` asks for the
 * extended query protocol, which refuses more than one statement per call.
 */
export type PostgresClient = {
  query(options: {
    readonly text: string
    readonly queryMode?: 'extended'
  }): Promise<PostgresQueryResult>
  release(): void
}

export type PostgresConnectionSource = {
  connect(): Promise<PostgresClient>
  end(): Promise<void>
}

export type PostgresConnectionConfig = {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string
  readonly ssl: boolean
}

export type PostgresAdapterOptions = {
  readonly name: string
  readonly schema: string
  readonly source: PostgresConnectionSource
  readonly logger: Logger
  /** Per-statement limit enforced by PostgreSQL (statement_timeout) and, with a margin, by the client. */
  readonly timeoutMs?: number
  readonly clock?: () => number
}

const DEFAULT_TIMEOUT_MS = 15_000
const CLIENT_TIMEOUT_MARGIN_MS = 2_000

// Dates and times stay as the text PostgreSQL sends (like mysql2's dateStrings), so values shown
// to the agent and written to rollback scripts are exactly what the database holds.
const DATE_TYPES = [1082, 1083, 1114, 1184, 1266] // date, time, timestamp, timestamptz, timetz
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    DATE_TYPES.includes(oid)
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format ?? 'text')) as typeof pg.types.getTypeParser,
}

/**
 * A small pool whose sessions default to read-only (`default_transaction_read_only`), so even a
 * statement outside the adapter's transactions could not write. Approved changes open their
 * transaction with an explicit READ WRITE.
 */
export const createPostgresConnectionSource = (
  config: PostgresConnectionConfig,
): PostgresConnectionSource =>
  new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ...(config.ssl ? { ssl: true } : {}),
    max: 2,
    connectionTimeoutMillis: 10_000,
    query_timeout: DEFAULT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
    options: '-c default_transaction_read_only=on',
    types,
  }) as unknown as PostgresConnectionSource

type Run = (sql: string) => Promise<PostgresQueryResult>

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  readonly name: string
  readonly dialect = 'postgres'
  readonly #schema: string
  readonly #source: PostgresConnectionSource
  readonly #logger: Logger
  readonly #timeoutMs: number
  readonly #clock: () => number

  constructor(options: PostgresAdapterOptions) {
    this.name = options.name
    this.#schema = options.schema
    this.#source = options.source
    this.#logger = options.logger
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#clock = options.clock ?? Date.now
  }

  async runReadQuery(query: GuardedQuery): Promise<Result<QueryResult, DatabaseError>> {
    const started = this.#clock()
    const result = await this.#readOnly((run) => run(query.sql))
    if (!result.ok) return result
    const { rows, fields } = result.value
    return ok({
      columns: fields.length > 0 ? fields.map((f) => f.name) : Object.keys(rows[0] ?? {}),
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
    const result = await this.#readOnly((run) => run(CAN_WRITE_SQL))
    if (!result.ok) return result
    return ok(result.value.rows[0]?.['can_write'] === true)
  }

  async introspect(): Promise<Result<DatabaseSchema, DatabaseError>> {
    const result = await this.#readOnly(async (run) => ({
      tables: (await run(TABLES_SQL)).rows,
      columns: (await run(COLUMNS_SQL)).rows,
      foreignKeys: (await run(FOREIGN_KEYS_SQL)).rows,
      indexes: (await run(INDEXES_SQL)).rows,
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

  async explain(
    query: GuardedQuery,
  ): Promise<Result<{ readonly usesIndex: boolean }, DatabaseError>> {
    const result = await this.#readOnly((run) => run(`EXPLAIN (FORMAT JSON) ${query.sql}`))
    if (!result.ok) return result
    const plan = result.value.rows[0]?.['QUERY PLAN']
    const nodes = planNodes(Array.isArray(plan) ? field(plan[0], 'Plan') : undefined)
    return ok({
      usesIndex:
        nodes.some((node) => INDEX_NODES.has(node)) && !nodes.some((node) => node === 'Seq Scan'),
    })
  }

  /**
   * The only write path: one approved statement in an explicit READ WRITE transaction, committed
   * only when PostgreSQL reports the expected row count, otherwise rolled back. An INSERT returns
   * its primary keys so the rollback script can name the new rows.
   */
  async executeChange(approved: ApprovedChange): Promise<Result<ChangeOutcome, ChangeError>> {
    const { change } = approved
    const sql =
      change.kind === 'insert'
        ? `${change.sql} RETURNING ${change.primaryKey.map((key) => quoteIdentifier(key, 'postgres')).join(', ')}`
        : change.sql
    const result = await this.#transaction('BEGIN READ WRITE', async (run) => {
      const outcome = await run(sql)
      const affectedRows = outcome.rowCount ?? -1
      if (affectedRows !== approved.expectedRows) {
        return err({
          kind: 'row-mismatch' as const,
          database: this.name,
          expected: approved.expectedRows,
          actual: affectedRows,
        })
      }
      await run('COMMIT')
      return ok({
        affectedRows,
        insertId: null,
        insertedKeys: change.kind === 'insert' ? outcome.rows : null,
      })
    })
    return result.ok ? result.value : result
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#source.end()
  }

  /**
   * Every read runs inside a READ ONLY transaction with a server-side time limit and is always
   * rolled back: PostgreSQL refuses writes and DDL there (DDL is transactional, so nothing commits
   * implicitly as in MySQL), and nothing is ever committed.
   */
  async #readOnly<T>(work: (run: Run) => Promise<T>): Promise<Result<T, DatabaseError>> {
    const result = await this.#transaction('BEGIN READ ONLY', async (run) => ok(await work(run)))
    return result.ok ? result.value : result
  }

  /**
   * Opens a transaction, sets its time limit and schema, and runs `work`. Whatever work leaves open
   * is rolled back (a committed change has already ended the transaction, so that is a no-op).
   * The caller's statements use the extended protocol: one statement per call, no batches.
   */
  async #transaction<T>(
    begin: 'BEGIN READ ONLY' | 'BEGIN READ WRITE',
    work: (run: Run) => Promise<T>,
  ): Promise<Result<T, DatabaseError>> {
    let client: PostgresClient
    try {
      client = await this.#source.connect()
    } catch (error) {
      return err(this.#mapError(error))
    }
    const run: Run = (text) => client.query({ text, queryMode: 'extended' })
    try {
      await client.query({ text: begin })
      await client.query({
        text: `SET LOCAL statement_timeout = ${Math.floor(this.#timeoutMs)}`,
      })
      await client.query({
        text: `SET LOCAL search_path TO ${quoteIdentifier(this.#schema, 'postgres')}`,
      })
      return ok(await work(run))
    } catch (error) {
      return err(this.#mapError(error))
    } finally {
      try {
        await client.query({ text: 'ROLLBACK' })
      } catch (error) {
        this.#logger.warn({ database: this.name, error: String(error) }, 'rollback failed')
      }
      client.release()
    }
  }

  #mapError(error: unknown): DatabaseError {
    const code = typeof field(error, 'code') === 'string' ? (field(error, 'code') as string) : ''
    const message = error instanceof Error ? error.message : String(error)
    const database = this.name
    if (UNREACHABLE_CODES.has(code) || /timeout expired|Connection terminated/i.test(message)) {
      return { kind: 'unreachable', database, message: code === '' ? message : code }
    }
    if (code === '28P01' || code === '28000' || code === '3D000') {
      return { kind: 'auth', database, message }
    }
    if (code === '57014' || /Query read timeout/i.test(message)) {
      return { kind: 'timeout', database, seconds: Math.round(this.#timeoutMs / 1000) }
    }
    if (code === '25006') return { kind: 'rejected-by-database', database, message }
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
])

const INDEX_NODES = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'])

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

/** Every node type of an EXPLAIN (FORMAT JSON) plan, depth first. */
const planNodes = (node: unknown): string[] => {
  const type = field(node, 'Node Type')
  const children = field(node, 'Plans')
  return [
    ...(typeof type === 'string' ? [type] : []),
    ...(Array.isArray(children) ? children.flatMap(planNodes) : []),
  ]
}

// Constant, parameter-free SQL against the catalog for the transaction's schema (search_path).
// The aliases match the MySQL introspection, so both engines share assembleTables.
const CAN_WRITE_SQL = `SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), FALSE)
  OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
        OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
  ) AS can_write`
const TABLES_SQL = `SELECT c.relname AS table_name,
  COALESCE(obj_description(c.oid, 'pg_class'), '') AS table_comment,
  CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS table_rows
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition`
const COLUMNS_SQL = `SELECT c.relname AS table_name, a.attname AS column_name,
  format_type(a.atttypid, a.atttypmod) AS column_type,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) THEN 'PRI'
    WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'u' AND a.attnum = ANY (k.conkey)) THEN 'UNI'
    WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND a.attnum = ANY (i.indkey::int2[])) THEN 'MUL'
    ELSE ''
  END AS column_key,
  pg_get_expr(d.adbin, d.adrelid) AS column_default,
  COALESCE(col_description(c.oid, a.attnum), '') AS column_comment
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  ORDER BY c.relname, a.attnum`
const FOREIGN_KEYS_SQL = `SELECT c.relname AS table_name, a.attname AS column_name,
  rc.relname AS referenced_table, ra.attname AS referenced_column
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class rc ON rc.oid = k.confrelid
  CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS cols(col, refcol)
  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = cols.col
  JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = cols.refcol
  WHERE k.contype = 'f' AND n.nspname = current_schema()`
const INDEXES_SQL = `SELECT c.relname AS table_name, ic.relname AS index_name,
  CASE WHEN i.indisunique THEN 0 ELSE 1 END AS non_unique, a.attname AS column_name
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class ic ON ic.oid = i.indexrelid
  CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  WHERE n.nspname = current_schema()
  ORDER BY c.relname, ic.relname, k.ord`
