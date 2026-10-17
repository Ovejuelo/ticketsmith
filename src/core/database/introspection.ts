import { z } from 'zod'
import type { TableInfo } from './database.schema.ts'

const text = z.union([z.string(), z.null()]).transform((value) => value ?? '')
/** The rows every engine's introspection queries return, under the same column aliases. */
export const IntrospectionSchema = z.object({
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

/** Builds the catalog's tables from the introspection rows, sorted by name. */
export const assembleTables = (rows: z.infer<typeof IntrospectionSchema>): TableInfo[] =>
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
