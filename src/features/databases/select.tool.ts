import { z } from 'zod'
import { ok } from '../../core/kernel/index.ts'
import { databasesContext, defineTool, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import { DEFAULT_ROWS, MAX_ROWS, readOne, renderFooter, renderMarkdownTable } from './read-query.ts'

export const SQL_RULES =
  'Only one read-only SELECT (or WITH … SELECT) is accepted; writes, locking reads, INTO, variables, SLEEP-like functions and comment tricks are rejected. It runs in a READ ONLY transaction with a time limit.'

export const selectTool = defineTool({
  name: 'db_select',
  title: 'Query a database (read-only)',
  description: `Run a read-only SQL query on one database of this project and get the rows as a Markdown table. ${SQL_RULES} Use db_schema first to find tables and columns.`,
  inputSchema: {
    database: z.string().describe('Database name (see db_schema or the project brief)'),
    sql: z
      .string()
      .describe(
        'One SELECT statement (MySQL); placeholders such as [EMAIL_1]@acme.com are allowed in literals',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROWS)
      .optional()
      .describe(`Maximum rows (default ${DEFAULT_ROWS})`),
  },
  requires: ['databases'],
  readOnly: true,
  run: async ({ database, sql, limit }, context) => {
    const databases = databasesContext(context)
    if (!databases.ok) return databases
    const resolved = context.resolvePlaceholders(sql)
    if (!resolved.ok) return { ok: false, error: unknownPlaceholdersMessage(resolved.error) }

    const result = await readOne(
      databases.value.connections,
      database,
      resolved.value,
      limit ?? DEFAULT_ROWS,
    )
    return result.ok
      ? ok(`${renderMarkdownTable(result.value)}\n\n${renderFooter(database, result.value)}`)
      : result
  },
})
