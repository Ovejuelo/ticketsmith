import type { Result } from '../kernel/index.ts'
import type { DatabaseSchema } from './database.schema.ts'
import type { Dialect, GuardedQuery } from './readonly-guard.ts'
import type { GuardedChange } from './write-guard.ts'

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

declare const approved: unique symbol

/**
 * A guarded change a human approved in the terminal. Only `approveChange` (features/changes, after
 * the typed confirmation) creates it; no MCP tool ever does, so the agent has no path to a write.
 */
export type ApprovedChange = {
  readonly change: GuardedChange
  /** Rows the re-run preflight counted; any other affected-row count rolls the change back. */
  readonly expectedRows: number
  readonly [approved]: true
}

export type ChangeOutcome = {
  readonly affectedRows: number
  /** First AUTO_INCREMENT id of an INSERT (MySQL assigns a single INSERT's ids consecutively). */
  readonly insertId: number | null
}

export type ChangeError =
  | DatabaseError
  | {
      readonly kind: 'row-mismatch'
      readonly database: string
      readonly expected: number
      readonly actual: number
    }

/**
 * One configured database. Reads only accept a GuardedQuery (produced by guardReadQuery) and
 * always run inside a READ ONLY transaction that is rolled back. The only write is
 * `executeChange`, which only accepts a human-approved change.
 */
export interface DatabaseAdapter extends AsyncDisposable {
  readonly name: string
  readonly dialect: Dialect
  runReadQuery(query: GuardedQuery): Promise<Result<QueryResult, DatabaseError>>
  ping(): Promise<Result<void, DatabaseError>>
  introspect(): Promise<Result<DatabaseSchema, DatabaseError>>
  /** Whether the account has write privileges (reported by doctor as a reminder). */
  accountCanWrite(): Promise<Result<boolean, DatabaseError>>
  /** EXPLAIN of a guarded read (read-only): whether every step uses an index. */
  explain(query: GuardedQuery): Promise<Result<{ readonly usesIndex: boolean }, DatabaseError>>
  /** Runs one approved change in a transaction; commits only if the affected rows match. */
  executeChange(approved: ApprovedChange): Promise<Result<ChangeOutcome, ChangeError>>
}
