import { z } from 'zod'

export const ColumnInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  /** PRI, UNI, MUL or empty. */
  key: z.string(),
  default: z.string().nullable(),
  comment: z.string(),
})

export const ForeignKeySchema = z.object({
  column: z.string(),
  referencesTable: z.string(),
  referencesColumn: z.string(),
})

export const IndexInfoSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
})

export const TableInfoSchema = z.object({
  name: z.string(),
  comment: z.string(),
  /** Engine estimate (information_schema.TABLES.TABLE_ROWS); null when unknown. */
  estimatedRows: z.number().nullable(),
  columns: z.array(ColumnInfoSchema),
  foreignKeys: z.array(ForeignKeySchema),
  indexes: z.array(IndexInfoSchema),
})
export type TableInfo = z.infer<typeof TableInfoSchema>

export type DatabaseSchema = { readonly tables: readonly TableInfo[] }

/**
 * Where investigated schemas live in the project's catalog. A "target" is a group of databases
 * sharing one schema, or a single ungrouped database. One catalog kind per target, keyed by table
 * name, so refreshing one target never touches another.
 */
export const DATABASE_CATALOG = {
  integration: 'databases',
  tableKind: (target: string) => `table:${target}`,
} as const
