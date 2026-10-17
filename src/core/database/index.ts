export {
  CHANGE_TTL_MS,
  ChangeIdSchema,
  type ChangeRequest,
  ChangeRequestSchema,
  type ChangeStatus,
  isExpired,
} from './change-request.schema.ts'
export { ChangeStore, newChangeId } from './change-store.ts'
export {
  ColumnInfoSchema,
  DATABASE_CATALOG,
  type DatabaseSchema,
  type TableInfo,
  TableInfoSchema,
} from './database.schema.ts'
export type {
  ApprovedChange,
  ChangeError,
  ChangeOutcome,
  DatabaseAdapter,
  DatabaseError,
  QueryResult,
} from './database-adapter.port.ts'
export { describeChangeError, describeDatabaseError } from './describe-error.ts'
export {
  insertRollback,
  type Preflight,
  preflightChange,
  SAMPLE_ROWS,
  updateRollback,
} from './preflight.ts'
export {
  type GuardedQuery,
  type GuardOptions,
  type GuardRejection,
  guardReadQuery,
} from './readonly-guard.ts'
export { DIALECT_LABEL, type Dialect } from './sql-dialect.ts'
export { quoteIdentifier, sqlLiteral } from './sql-literal.ts'
export {
  type ChangeKind,
  type GuardedChange,
  guardChange,
  type WriteGuardOptions,
} from './write-guard.ts'
