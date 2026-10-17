import { z } from 'zod'
import { DIALECT_LABEL, type TableInfo } from '../../core/database/index.ts'
import { err, ok } from '../../core/kernel/index.ts'
import { databasesContext, defineTool } from '../../core/mcp/index.ts'

export const schemaTool = defineTool({
  name: 'db_schema',
  title: 'Describe a database schema',
  description:
    'List the tables of a database or group (from the investigated schema, without touching the database), or describe one table: columns, types, keys, foreign keys, indexes and which tables reference it.',
  inputSchema: {
    target: z.string().describe('Group or database name'),
    table: z.string().optional().describe('Table to describe; omit to list all tables'),
  },
  requires: ['databases'],
  readOnly: true,
  run: async ({ target, table }, context) => {
    const databases = databasesContext(context)
    if (!databases.ok) return databases
    const members = databases.value.connections.resolveTarget(target)
    if (!members.ok) return members
    const schemaTarget = members.value[0]?.group ?? members.value[0]?.name ?? target
    const engine = DIALECT_LABEL[members.value[0]?.type ?? 'mysql']

    const tables = await databases.value.tables(schemaTarget)
    if (!tables.ok) return tables
    if (tables.value.length === 0) {
      return err(
        `No investigated schema for "${schemaTarget}". Run \`ticketsmith project refresh databases\`.`,
      )
    }
    if (table === undefined) return ok(renderTableList(schemaTarget, engine, tables.value))

    const found = tables.value.find(
      (candidate) => candidate.name.toLowerCase() === table.toLowerCase(),
    )
    if (found === undefined) {
      const similar = tables.value
        .filter((candidate) => candidate.name.toLowerCase().includes(table.toLowerCase()))
        .map((candidate) => candidate.name)
        .slice(0, 10)
      return err(
        `Table "${table}" not found in "${schemaTarget}".${similar.length > 0 ? ` Similar: ${similar.join(', ')}.` : ''}`,
      )
    }
    return ok(`${renderTable(found, tables.value)}\nEngine: ${engine}`)
  },
})

const renderTableList = (target: string, engine: string, tables: readonly TableInfo[]): string =>
  [
    `${tables.length} tables in ${target} (${engine}; write SQL in its dialect):`,
    '',
    ...tables.map(
      (t) =>
        `- ${t.name}${t.estimatedRows === null ? '' : ` (~${t.estimatedRows} rows)`}, ${t.columns.length} columns${t.comment ? ` — ${t.comment}` : ''}`,
    ),
  ].join('\n')

const renderTable = (table: TableInfo, all: readonly TableInfo[]): string => {
  const referencedBy = all.flatMap((other) =>
    other.foreignKeys
      .filter((fk) => fk.referencesTable === table.name)
      .map((fk) => `${other.name}.${fk.column} → ${fk.referencesColumn}`),
  )
  return [
    `# ${table.name}${table.estimatedRows === null ? '' : ` (~${table.estimatedRows} rows)`}`,
    ...(table.comment ? ['', table.comment] : []),
    '',
    '| Column | Type | Null | Key | Default | Comment |',
    '| --- | --- | --- | --- | --- | --- |',
    ...table.columns.map(
      (c) =>
        `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : ''} | ${c.key} | ${c.default ?? ''} | ${c.comment} |`,
    ),
    '',
    `Foreign keys: ${table.foreignKeys.map((fk) => `${fk.column} → ${fk.referencesTable}.${fk.referencesColumn}`).join(', ') || 'none'}`,
    `Referenced by: ${referencedBy.join(', ') || 'none'}`,
    `Indexes: ${table.indexes.map((i) => `${i.name}(${i.columns.join(', ')})${i.unique ? ' unique' : ''}`).join(', ') || 'none'}`,
  ].join('\n')
}
