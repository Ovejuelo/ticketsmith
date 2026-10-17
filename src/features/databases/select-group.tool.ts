import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { databasesContext, defineTool, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import {
  type DatabaseAnswer,
  DEFAULT_ROWS,
  MAX_ROWS,
  readGroup,
  renderFooter,
  renderMarkdownTable,
} from './read-query.ts'
import { SQL_RULES } from './select.tool.ts'

export const selectGroupTool = defineTool({
  name: 'db_select_group',
  title: 'Query every database of a group (read-only)',
  description: `Run the same read-only SQL on every database of a group that shares one schema (e.g. to find which database holds an account) and get the rows per database. ${SQL_RULES}`,
  inputSchema: {
    group: z.string().describe('Group name (see the project brief or db_schema)'),
    sql: z
      .string()
      .describe(
        'One SELECT statement in the dialect of the group engine; placeholders are allowed in literals',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROWS)
      .optional()
      .describe(`Maximum rows per database (default ${DEFAULT_ROWS})`),
  },
  requires: ['databases'],
  readOnly: true,
  run: async ({ group, sql, limit }, context) => {
    const databases = databasesContext(context)
    if (!databases.ok) return databases
    const resolved = context.resolvePlaceholders(sql)
    if (!resolved.ok) return err(unknownPlaceholdersMessage(resolved.error))

    const answers = await readGroup(
      databases.value.connections,
      group,
      resolved.value,
      limit ?? DEFAULT_ROWS,
    )
    return answers.ok ? ok(renderGroup(group, answers.value)) : answers
  },
})

const renderGroup = (group: string, answers: readonly DatabaseAnswer[]): string => {
  const withRows = answers.filter((a) => a.result.ok && a.result.value.rows.length > 0)
  const empty = answers
    .filter((a) => a.result.ok && a.result.value.rows.length === 0)
    .map((a) => a.database)
  const failed = answers.flatMap((a) => (a.result.ok ? [] : [`- ${a.database}: ${a.result.error}`]))
  return [
    `Group ${group}: ${withRows.length} of ${answers.length} database(s) returned rows.`,
    ...withRows.flatMap((a) =>
      a.result.ok
        ? [
            '',
            `## ${a.database}`,
            '',
            renderMarkdownTable(a.result.value),
            '',
            renderFooter(a.database, a.result.value),
          ]
        : [],
    ),
    ...(empty.length > 0 ? ['', `No rows: ${empty.join(', ')}`] : []),
    ...(failed.length > 0 ? ['', 'Failed:', ...failed] : []),
  ].join('\n')
}
