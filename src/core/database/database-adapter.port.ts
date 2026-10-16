import type { Result } from '../kernel/index.ts'
import type { DatabaseSchema } from './database.schema.ts'
import type { Dialect, GuardedQuery } from './readonly-guard.ts'

export type QueryResult = {
  readonly columns: readonly string[]
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  /** More rows matched than the guard's maxRows; only the first maxRows are returned. */
  readonly truncated: boolean
  readonly elapsedMs: number
}

export type DatabaseError =
  | { readonly kind: 'unreachable'; readonly database: string; readonly message: string }
  | { readonly kind: 'auth'; readonly database: string; readonly message: string }
  | { readonly kind: 'timeout'; readonly database: string; readonly seconds: number }
  | { readonly kind: 'rejected-by-database'; readonly database: string; readonly message: string }
  | { readonly kind: 'query'; readonly database: string; readonly message: string }

/**
 * One configured database. Reads only accept a GuardedQuery (produced by guardReadQuery) and
 * always run inside a READ ONLY transaction that is rolled back; there is no write method.
 */
export interface DatabaseAdapter extends AsyncDisposable {
  readonly name: string
  readonly dialect: Dialect
  runReadQuery(query: GuardedQuery): Promise<Result<QueryResult, DatabaseError>>
  ping(): Promise<Result<void, DatabaseError>>
  introspect(): Promise<Result<DatabaseSchema, DatabaseError>>
  /** Whether the account has write privileges (reported by doctor as a reminder). */
  accountCanWrite(): Promise<Result<boolean, DatabaseError>>
}
