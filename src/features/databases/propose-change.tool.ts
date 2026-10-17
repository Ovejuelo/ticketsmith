import { z } from 'zod'
import {
  CHANGE_TTL_MS,
  type ChangeRequest,
  ChangeStore,
  guardChange,
  newChangeId,
  preflightChange,
} from '../../core/database/index.ts'
import { err, ok } from '../../core/kernel/index.ts'
import { databasesContext, defineTool, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import { renderMarkdownTable } from './read-query.ts'

export const CHANGE_RULES =
  'Exactly one INSERT INTO t (columns) VALUES (…) or one UPDATE t SET … WHERE … on one table with a primary key. The WHERE must pin rows with at least one "column = literal" or "column IN (literals)" joined by AND. Never DELETE, REPLACE, DDL, INSERT … SELECT, ON DUPLICATE KEY, subqueries, variables, ORDER BY/LIMIT in UPDATE, or functions other than NOW, CURRENT_TIMESTAMP, UTC_TIMESTAMP, CONCAT, COALESCE, IFNULL, UPPER, LOWER, TRIM, ROUND.'

export const proposeChangeTool = defineTool({
  name: 'db_propose_change',
  title: 'Propose a database change (a human approves it)',
  description: `Propose one data change for a human to approve. It is NOT executed: Ticketsmith validates it, counts and samples the affected rows (read-only), prepares a rollback script and stores it as a change request; the human then reviews and approves it in their own terminal. You cannot approve or run it. ${CHANGE_RULES} Measure the current state with db_select first and pass the row count you expect.`,
  inputSchema: {
    database: z.string().describe('Database name (it must allow changes in this project)'),
    sql: z
      .string()
      .describe(
        'One INSERT … VALUES or UPDATE … WHERE in the dialect of the database engine (MySQL or PostgreSQL); placeholders such as [EMAIL_1]@acme.com are allowed',
      ),
    reason: z.string().min(10).describe('Why, in one or two sentences the approver will read'),
    ticket: z.string().optional().describe('The ticket key this change resolves, e.g. OPS-123'),
    expectedRows: z.number().int().min(1).describe('How many rows you expect it to affect'),
  },
  requires: ['databases'],
  readOnly: false,
  availableWhen: (context) =>
    context.databases?.connections.configs.some((config) => config.allowChanges) ?? false,
  run: async ({ database, sql, reason, ticket, expectedRows }, context) => {
    const databases = databasesContext(context)
    if (!databases.ok) return databases
    const { connections, changes } = databases.value
    const config = connections.configs.find((candidate) => candidate.name === database)
    if (config === undefined) {
      const allowed = connections.configs.filter((c) => c.allowChanges).map((c) => c.name)
      return err(
        `Unknown database "${database}". Databases that allow changes: ${allowed.join(', ')}.`,
      )
    }
    if (!config.allowChanges) {
      return err(
        `Database "${database}" is read-only in this project: changes cannot be proposed there.`,
      )
    }
    const resolved = context.resolvePlaceholders(sql)
    if (!resolved.ok) return err(unknownPlaceholdersMessage(resolved.error))

    const tables = await databases.value.tables(config.group ?? config.name)
    if (!tables.ok) return tables
    if (tables.value.length === 0) {
      return err(
        `No schema investigated for "${database}" yet: the user must run \`ticketsmith project refresh databases\`.`,
      )
    }
    const guarded = guardChange(resolved.value, {
      dialect: config.type,
      tables: tables.value,
    })
    if (!guarded.ok) return err(`Change rejected: ${guarded.error.reason}`)

    const adapter = await connections.connect(database)
    if (!adapter.ok) return adapter
    const id = newChangeId()
    const preflight = await preflightChange(adapter.value, guarded.value, {
      maxRows: changes.maxRows,
      changeId: id,
    })
    if (!preflight.ok) return err(`Change rejected: ${preflight.error}`)
    if (preflight.value.rows !== expectedRows) {
      return err(
        `Change rejected: it would affect ${preflight.value.rows} rows, not the ${expectedRows} you expected. Check the WHERE with db_select and propose again.`,
      )
    }

    const now = new Date()
    const request: ChangeRequest = {
      id,
      database,
      ticket: ticket?.trim().toUpperCase() || null,
      reason,
      sql: guarded.value.sql,
      kind: guarded.value.kind,
      table: guarded.value.table,
      preflight: {
        rows: preflight.value.rows,
        sample: [...preflight.value.sample],
        usesIndex: preflight.value.usesIndex,
      },
      rollbackSql: preflight.value.rollbackSql,
      status: 'proposed',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHANGE_TTL_MS).toISOString(),
    }
    const saved = await new ChangeStore(changes.dir).save(request)
    if (!saved.ok) return saved

    const sample =
      request.preflight.sample.length === 0
        ? ''
        : `\n\nRows it will change (current values, first ${request.preflight.sample.length}):\n\n${renderMarkdownTable(
            {
              columns: Object.keys(request.preflight.sample[0] ?? {}),
              rows: request.preflight.sample,
              truncated: false,
              elapsedMs: 0,
            },
          )}`
    return ok(
      [
        `Change request ${id} is waiting for a human: it has NOT run.`,
        '',
        `- Database: ${database} · table ${request.table} · ${request.kind.toUpperCase()} of ${request.preflight.rows} row(s)`,
        `- SQL: ${request.sql}`,
        ...(request.preflight.usesIndex === false
          ? ['- Warning: finding the rows does not use an index.']
          : []),
        `- Expires: ${request.expiresAt}`,
        '',
        `Tell the user to review and approve it in their terminal: \`ticketsmith changes show ${id}\`, then \`ticketsmith changes approve ${id}\`. You cannot approve it.`,
      ].join('\n') + sample,
    )
  },
})
