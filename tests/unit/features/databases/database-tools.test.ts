import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import type { TableInfo } from '#src/core/database/index.ts'
import { err, ok } from '#src/core/kernel/index.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { DatabaseConnections } from '#src/core/services/index.ts'
import { databasesFeature } from '#src/features/databases/index.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { emptyResult } from '#tests/support/fake-database.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

const users: TableInfo = {
  name: 'users',
  comment: '',
  estimatedRows: 10,
  columns: [
    { name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, comment: '' },
    {
      name: 'email',
      type: 'varchar(255)',
      nullable: false,
      key: 'UNI',
      default: null,
      comment: '',
    },
  ],
  foreignKeys: [],
  indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true }],
}

describe('database MCP tools', () => {
  let cli: FakeCli
  let client: Client
  let audit: InMemoryAuditLog
  const project = withDatabases(testProject(null), [
    testDatabase('shard1', { group: 'shards' }),
    testDatabase('shard2', { group: 'shards' }),
    testDatabase('shard3', { group: 'shards' }),
  ])

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(project)
    audit = new InMemoryAuditLog()
    const server = createMcpServer({
      project: 'acme',
      tools: databasesFeature.tools,
      integrations: ['databases'],
      context: {
        tickets: null,
        repos: null,
        knowledge: { dir: '/nonexistent/knowledge' },
        databases: {
          connections: new DatabaseConnections(cli.services, project),
          tables: async (target) => ok(target === 'shards' ? [users] : []),
        },
      },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit,
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })
  afterEach(async () => {
    await client.close()
    await cli.cleanup()
  })

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args })

  it('runs guarded reads, masks the rows and resolves placeholders server-side', async () => {
    const shard1 = cli.databases.get('shard1')
    shard1.answer = (sql) =>
      ok({
        ...emptyResult,
        columns: ['id', 'email'],
        rows: sql.includes("'ana@northwind.mx'")
          ? [{ id: 7, email: 'ana@northwind.mx' }]
          : [{ id: 1, email: 'ana@northwind.mx' }],
      })

    const first = textOf(
      await call('db_select', { database: 'shard1', sql: 'SELECT id, email FROM users' }),
    )
    expect(first).toContain('| 1 | [EMAIL_1]@northwind.mx |')
    expect(first).not.toContain('ana@northwind.mx')

    await call('db_select', {
      database: 'shard1',
      sql: "SELECT id, email FROM users WHERE email = '[EMAIL_1]@northwind.mx'",
    })
    expect(shard1.queries.at(-1)).toBe(
      "SELECT `id`, `email` FROM `users` WHERE `email` = 'ana@northwind.mx' LIMIT 201",
    )
    expect(JSON.stringify(audit.entries)).not.toContain('ana@northwind.mx')
  })

  it('rejects unsafe SQL without touching the database', async () => {
    const result = await call('db_select', {
      database: 'shard1',
      sql: 'UPDATE users SET email = NULL',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Query rejected: Only a single SELECT/)
    expect(cli.databases.connections).toEqual([])
  })

  it('points to the group tool when given a group name', async () => {
    const result = await call('db_select', { database: 'shards', sql: 'SELECT 1' })
    expect(textOf(result)).toMatch(/is a group; use db_select_group/)
  })

  it('queries every database of a group and reports each one', async () => {
    cli.databases.get('shard1').answer = () =>
      ok({ ...emptyResult, columns: ['id'], rows: [{ id: 3 }] })
    cli.databases.get('shard3').answer = () =>
      err({ kind: 'unreachable', database: 'shard3', message: 'ETIMEDOUT' })

    const text = textOf(
      await call('db_select_group', {
        group: 'shards',
        sql: 'SELECT id FROM accounts WHERE id = 3',
      }),
    )
    expect(text).toContain('Group shards: 1 of 3 database(s) returned rows.')
    expect(text).toContain('## shard1')
    expect(text).toContain('No rows: shard2')
    expect(text).toMatch(/- shard3: Database "shard3" is unreachable/)
  })

  it('describes the schema from the catalog', async () => {
    expect(textOf(await call('db_schema', { target: 'shard2' }))).toContain(
      '- users (~10 rows), 2 columns',
    )
    expect(textOf(await call('db_schema', { target: 'shards', table: 'USERS' }))).toContain(
      '| email | varchar(255) |',
    )
    expect(textOf(await call('db_schema', { target: 'shards', table: 'user' }))).toMatch(
      /not found.*Similar: users/,
    )
    expect(textOf(await call('db_schema', { target: 'nope' }))).toMatch(
      /Unknown database or group "nope"/,
    )
  })
})
