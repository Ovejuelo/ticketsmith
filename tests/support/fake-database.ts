import type {
  DatabaseAdapter,
  DatabaseError,
  DatabaseSchema,
  GuardedQuery,
  QueryResult,
} from '#src/core/database/index.ts'
import { ok, type Result } from '#src/core/kernel/index.ts'

export const emptyResult: QueryResult = { columns: [], rows: [], truncated: false, elapsedMs: 1 }

/** A scripted DatabaseAdapter; records the SQL it was asked to run. */
export class FakeDatabaseAdapter implements DatabaseAdapter {
  readonly name: string
  readonly dialect = 'mysql'
  readonly queries: string[] = []
  pingResult: Result<void, DatabaseError> = ok(undefined)
  canWrite = false
  schema: Result<DatabaseSchema, DatabaseError> = ok({ tables: [] })
  introspections = 0
  answer: (sql: string) => Result<QueryResult, DatabaseError> = () => ok(emptyResult)
  disposed = false

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
