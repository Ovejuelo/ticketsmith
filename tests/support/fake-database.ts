import type {
  ApprovedChange,
  ChangeError,
  ChangeOutcome,
  DatabaseAdapter,
  DatabaseError,
  DatabaseSchema,
  Dialect,
  GuardedQuery,
  QueryResult,
} from '#src/core/database/index.ts'
import { err, ok, type Result } from '#src/core/kernel/index.ts'

export const emptyResult: QueryResult = { columns: [], rows: [], truncated: false, elapsedMs: 1 }

/** A scripted DatabaseAdapter; records the SQL it was asked to run. */
export class FakeDatabaseAdapter implements DatabaseAdapter {
  readonly name: string
  dialect: Dialect = 'mysql'
  readonly queries: string[] = []
  pingResult: Result<void, DatabaseError> = ok(undefined)
  canWrite = false
  schema: Result<DatabaseSchema, DatabaseError> = ok({ tables: [] })
  introspections = 0
  answer: (sql: string) => Result<QueryResult, DatabaseError> = () => ok(emptyResult)
  disposed = false
  usesIndex = true
  readonly executed: string[] = []
  /** Affected rows MySQL would report (default: what the approval expects). */
  affectedRows: ((approved: ApprovedChange) => number) | null = null
  insertId: number | null = null

  constructor(name: string) {
    this.name = name
  }

  async runReadQuery(query: GuardedQuery) {
    this.queries.push(query.sql)
    return this.answer(query.sql)
  }
  async ping() {
    return this.pingResult
  }
  async introspect() {
    this.introspections++
    return this.schema
  }
  async accountCanWrite() {
    return ok(this.canWrite)
  }
  async explain(query: GuardedQuery) {
    this.queries.push(`EXPLAIN ${query.sql}`)
    return ok({ usesIndex: this.usesIndex })
  }
  async executeChange(approved: ApprovedChange): Promise<Result<ChangeOutcome, ChangeError>> {
    const affectedRows = this.affectedRows?.(approved) ?? approved.expectedRows
    if (affectedRows !== approved.expectedRows) {
      return err({
        kind: 'row-mismatch',
        database: this.name,
        expected: approved.expectedRows,
        actual: affectedRows,
      })
    }
    this.executed.push(approved.change.sql)
    return ok({ affectedRows, insertId: this.insertId, insertedKeys: null })
  }
  async [Symbol.asyncDispose]() {
    this.disposed = true
  }
}

/** Hands out one fake adapter per database name and remembers the passwords used. */
export class FakeDatabases {
  readonly #adapters = new Map<string, FakeDatabaseAdapter>()
  readonly connections: { name: string; password: string }[] = []

  get(name: string): FakeDatabaseAdapter {
    let adapter = this.#adapters.get(name)
    if (adapter === undefined) {
      adapter = new FakeDatabaseAdapter(name)
      this.#adapters.set(name, adapter)
    }
    return adapter
  }

  connect(name: string, password: string): FakeDatabaseAdapter {
    this.connections.push({ name, password })
    return this.get(name)
  }
}
