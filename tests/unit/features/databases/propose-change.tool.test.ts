import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FEATURES } from '#src/bootstrap/features.ts'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import { ChangeStore, type TableInfo } from '#src/core/database/index.ts'
import { ok } from '#src/core/kernel/index.ts'
import type { Project } from '#src/core/project/index.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { DatabaseConnections } from '#src/core/services/index.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { emptyResult } from '#tests/support/fake-database.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

const accounts: TableInfo = {
  name: 'accounts',
  comment: '',
  estimatedRows: 10,
  columns: ['id', 'email', 'status'].map((name) => ({
    name,
    type: 'varchar(255)',
    nullable: true,
    key: name === 'id' ? 'PRI' : '',
    default: null,
    comment: '',
  })),
  foreignKeys: [],
  indexes: [],
}

describe('MCP tool db_propose_change', () => {
  let cli: FakeCli
  let client: Client
  let changesDir: string

  const serve = async (project: Project) => {
    cli = await (await FakeCli.create()).withProject(project)
    changesDir = join(cli.home, 'changes')
    const server = createMcpServer({
      project: 'acme',
      tools: FEATURES.flatMap((feature) => feature.tools),
      integrations: ['databases'],
      context: {
        tickets: null,
        repos: null,
        knowledge: { dir: '/nonexistent/knowledge' },
        databases: {
          connections: new DatabaseConnections(cli.services, project),
          changes: { dir: changesDir, maxRows: 100 },
          tables: async () => ok([accounts]),
        },
      },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit: new InMemoryAuditLog(),
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  }
  afterEach(async () => {
    await client.close()
    await cli.cleanup()
  })

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args })

  describe('with a database that allows changes', () => {
    beforeEach(() =>
      serve(
        withDatabases(testProject(null), [
          testDatabase('shard1', { allowChanges: true }),
          testDatabase('reports'),
        ]),
      ),
    )

    it('stores a validated, measured proposal with real values and answers masked', async () => {
      const shard1 = cli.databases.get('shard1')
      shard1.answer = (sql) =>
        ok({
          ...emptyResult,
          columns: ['id', 'email', 'status'],
          rows:
            sql.includes("'ana@northwind.mx'") ||
            sql.startsWith('SELECT `id`, `email`, `status` FROM `users`')
              ? [{ id: 7, email: 'ana@northwind.mx', status: 'active' }]
              : [{ id: 7, status: 'active' }],
        })
      // The agent first looks the account up and only ever sees a placeholder.
      const lookup = textOf(
        await call('db_select', { database: 'shard1', sql: 'SELECT id, email, status FROM users' }),
      )
      expect(lookup).toContain('[EMAIL_1]@northwind.mx')

      const result = await call('db_propose_change', {
        database: 'shard1',
        sql: "UPDATE accounts SET status = 'inactive' WHERE email = '[EMAIL_1]@northwind.mx'",
        reason: 'The customer asked to close the account in OPS-7.',
        ticket: 'ops-7',
        expectedRows: 1,
      })
      const text = textOf(result)
      expect(result.isError).toBeFalsy()
      expect(text).toMatch(
        /^Change request cr-[0-9a-f]{8} is waiting for a human: it has NOT run\./,
      )
      expect(text).toContain("WHERE `email` = '[EMAIL_1]@northwind.mx'")
      expect(text).not.toContain('ana@northwind.mx')
      expect(text).toMatch(/ticketsmith changes approve cr-[0-9a-f]{8}/)

      const [stored] = await new ChangeStore(changesDir).list()
      expect(stored).toMatchObject({
        database: 'shard1',
        ticket: 'OPS-7',
        status: 'proposed',
        kind: 'update',
        table: 'accounts',
        sql: "UPDATE `accounts` SET `status` = 'inactive' WHERE `email` = 'ana@northwind.mx'",
        preflight: { rows: 1, usesIndex: true },
      })
      expect(stored?.rollbackSql).toContain(
        "UPDATE `accounts` SET `status` = 'active' WHERE `id` = 7;",
      )
      expect(shard1.executed).toEqual([]) // proposing never runs anything
    })

    it('rejects read-only databases, unsafe SQL, wrong expectations and unknown placeholders', async () => {
      cli.databases.get('shard1').answer = () =>
        ok({ ...emptyResult, rows: [{ id: 1 }, { id: 2 }] })
      const attempt = async (args: Record<string, unknown>) => {
        const result = await call('db_propose_change', {
          reason: 'A reason long enough.',
          expectedRows: 1,
          database: 'shard1',
          ...args,
        })
        expect(result.isError).toBe(true)
        return textOf(result)
      }
      expect(
        await attempt({
          database: 'reports',
          sql: "UPDATE accounts SET status = 'x' WHERE id = 1",
        }),
      ).toMatch(/read-only in this project/)
      expect(await attempt({ sql: 'DELETE FROM accounts WHERE id = 1' })).toMatch(
        /DELETE is never allowed/,
      )
      expect(await attempt({ sql: "UPDATE accounts SET status = 'x' WHERE 1 = 1" })).toMatch(
        /must pin rows/,
      )
      expect(await attempt({ sql: "UPDATE accounts SET status = 'x' WHERE id IN (1, 2)" })).toMatch(
        /affect 2 rows, not the 1 you expected/,
      )
      expect(
        await attempt({ sql: "UPDATE accounts SET status = 'x' WHERE email = '[EMAIL_9]'" }),
      ).toMatch(/Unknown placeholder/)
      // The ticket names an output folder: a path must never get through.
      expect(
        await attempt({
          sql: "UPDATE accounts SET status = 'x' WHERE id = 1",
          ticket: '../../../tmp/x',
        }),
      ).toMatch(/Invalid ticket/)
      expect(await new ChangeStore(changesDir).list()).toEqual([])
    })
  })

  it('does not exist when no database allows changes', async () => {
    await serve(withDatabases(testProject(null), [testDatabase('shard1')]))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('db_select')
    expect(names).not.toContain('db_propose_change')
  })

  it('no MCP tool can execute or approve a change', async () => {
    const root = new URL('../../../../src/features/', import.meta.url).pathname
    const entries = await readdir(root, { recursive: true })
    const toolFiles = entries.filter((file) => file.endsWith('.tool.ts'))
    expect(toolFiles.length).toBeGreaterThan(10)
    for (const file of toolFiles) {
      const source = await readFile(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/executeChange|approveChange|ApprovedChange/)
    }
  })
})
