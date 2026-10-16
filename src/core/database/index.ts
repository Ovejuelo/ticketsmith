export {
  ColumnInfoSchema,
  DATABASE_CATALOG,
  type DatabaseSchema,
  type TableInfo,
  TableInfoSchema,
} from './database.schema.ts'
export type { DatabaseAdapter, DatabaseError, QueryResult } from './database-adapter.port.ts'
export { describeDatabaseError } from './describe-error.ts'
export {
  type Dialect,
  type GuardedQuery,
  type GuardOptions,
  type GuardRejection,
  guardReadQuery,
} from './readonly-guard.ts'
