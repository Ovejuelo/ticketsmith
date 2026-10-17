import { describe, expect, it } from 'vitest'
import type { ApprovedChange, TableInfo } from '#src/core/database/index.ts'
import { guardChange, guardReadQuery } from '#src/core/database/index.ts'
import { PostgresDatabaseAdapter } from '#src/core/database/providers/postgres/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'
import { FakePostgres, pgRows, postgresErrors } from '#tests/support/fake-postgres.ts'

const adapterWith = (fake: FakePostgres) =>
  new PostgresDatabaseAdapter({
    name: 'pg1',
    schema: 'billing',
    source: fake,
    logger: createLogger({ level: 'silent' }),
    timeoutMs: 15_000,
    clock: () => 0,
  })

const guarded = (sql: string, maxRows = 2) => {
  const result = guardReadQuery(sql, { dialect: 'postgres', maxRows })
  if (!result.ok) throw new Error(result.error.reason)
  return result.value
}

const accounts: TableInfo = {
  name: 'accounts',
  comment: '',
  estimatedRows: 10,
  columns: ['id', 'status'].map((name) => ({
    name,
    type: 'text',
    nullable: true,
    key: name === 'id' ? 'PRI' : '',
    default: null,
    comment: '',
  })),
  foreignKeys: [],
  indexes: [],
}

/** Approval normally happens in features/changes after the typed confirmation. */
const approved = (sql: string, expectedRows: number): ApprovedChange => {
  const change = guardChange(sql, { dialect: 'postgres', tables: [accounts] })
  if (!change.ok) throw new Error(change.error.reason)
  return { change: change.value, expectedRows } as ApprovedChange
}

describe('PostgresDatabaseAdapter reads', () => {
  it('runs one extended-protocol statement in a time-limited READ ONLY transaction, always rolled back', async () => {
    const fake = new FakePostgres().on(/FROM "users"/, pgRows([{ id: 1 }]))
    const result = await adapterWith(fake).runReadQuery(guarded('SELECT id FROM users'))

    expect(result).toEqual({
      ok: true,
      value: { columns: ['id'], rows: [{ id: 1 }], truncated: false, elapsedMs: 0 },
    })
    expect(fake.statements).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 15000',
      'SET LOCAL search_path TO "billing"',
      'SELECT id FROM "users" LIMIT 3',
      'ROLLBACK',
    ])
    expect(fake.extended).toEqual([false, false, false, true, false])
    expect(fake.released).toBe(1)
  })

  it('reports truncation and maps errors, rolling back every time', async () => {
    const fake = new FakePostgres().on(/FROM "t"/, pgRows([{ a: 1 }, { a: 2 }, { a: 3 }]))
    expect(await adapterWith(fake).runReadQuery(guarded('SELECT a FROM t'))).toMatchObject({
      ok: true,
      value: { rows: [{ a: 1 }, { a: 2 }], truncated: true },
    })

    for (const [error, expected] of [
      [postgresErrors.timeout(), { kind: 'timeout', seconds: 15 }],
      [postgresErrors.auth(), { kind: 'auth' }],
      [postgresErrors.readOnly(), { kind: 'rejected-by-database' }],
      [postgresErrors.refused(), { kind: 'unreachable', message: 'ECONNREFUSED' }],
    ] as const) {
      const failing = new FakePostgres().on(/FROM "t"/, error)
      expect(await adapterWith(failing).runReadQuery(guarded('SELECT a FROM t'))).toMatchObject({
        ok: false,
        error: { database: 'pg1', ...expected },
      })
      expect(failing.statements.at(-1)).toBe('ROLLBACK')
      expect(failing.released).toBe(1)
    }
  })

  it('reads the plan: an index scan uses an index, a sequential scan does not', async () => {
    const plan = (root: unknown) => pgRows([{ 'QUERY PLAN': [{ Plan: root }] }])
    const indexed = new FakePostgres().on(
      /^EXPLAIN \(FORMAT JSON\)/,
      plan({ 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan' }] }),
    )
    expect(await adapterWith(indexed).explain(guarded('SELECT id FROM t WHERE id = 1'))).toEqual({
      ok: true,
      value: { usesIndex: true },
    })
    const scanned = new FakePostgres().on(
      /^EXPLAIN/,
      plan({ 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Seq Scan' }] }),
    )
    expect(await adapterWith(scanned).explain(guarded('SELECT id FROM t'))).toEqual({
      ok: true,
      value: { usesIndex: false },
    })
  })

  it('reports whether the account can write and assembles the catalog', async () => {
    const fake = new FakePostgres()
      .on(/AS can_write/, pgRows([{ can_write: true }]))
      .on(
        /AS table_comment/,
        pgRows([{ table_name: 'accounts', table_comment: '', table_rows: '12' }]),
      )
      .on(
        /AS column_type/,
        pgRows([
          {
            table_name: 'accounts',
            column_name: 'id',
            column_type: 'bigint',
            is_nullable: 'NO',
            column_key: 'PRI',
            column_default: "nextval('accounts_id_seq'::regclass)",
            column_comment: '',
          },
        ]),
      )
      .on(
        /AS non_unique/,
        pgRows([
          { table_name: 'accounts', index_name: 'accounts_pkey', non_unique: 0, column_name: 'id' },
        ]),
      )
    const adapter = adapterWith(fake)
    expect(await adapter.accountCanWrite()).toEqual({ ok: true, value: true })
    expect(await adapter.introspect()).toEqual({
      ok: true,
      value: {
        tables: [
          {
            name: 'accounts',
            comment: '',
            estimatedRows: 12,
            columns: [
              {
                name: 'id',
                type: 'bigint',
                nullable: false,
                key: 'PRI',
                default: "nextval('accounts_id_seq'::regclass)",
                comment: '',
              },
            ],
            foreignKeys: [],
            indexes: [{ name: 'accounts_pkey', columns: ['id'], unique: true }],
          },
        ],
      },
    })
  })
})

describe('PostgresDatabaseAdapter.executeChange', () => {
  it('commits in an explicit READ WRITE transaction when the row count matches', async () => {
    const fake = new FakePostgres().on(/^UPDATE/, pgRows([], 2))
    const result = await adapterWith(fake).executeChange(
      approved("UPDATE accounts SET status = 'x' WHERE id IN (1, 2)", 2),
    )
    expect(result).toEqual({
      ok: true,
      value: { affectedRows: 2, insertId: null, insertedKeys: null },
    })
    expect(fake.statements).toEqual([
      'BEGIN READ WRITE',
      'SET LOCAL statement_timeout = 15000',
      'SET LOCAL search_path TO "billing"',
      'UPDATE "accounts" SET status = \'x\' WHERE id IN (1, 2)',
      'COMMIT',
      'ROLLBACK', // harmless after COMMIT: nothing is left open either way
    ])
  })

  it('rolls back when the row count differs', async () => {
    const fake = new FakePostgres().on(/^UPDATE/, pgRows([], 3))
    expect(
      await adapterWith(fake).executeChange(
        approved("UPDATE accounts SET status = 'x' WHERE id IN (1, 2)", 2),
      ),
    ).toEqual({
      ok: false,
      error: { kind: 'row-mismatch', database: 'pg1', expected: 2, actual: 3 },
    })
    expect(fake.statements).not.toContain('COMMIT')
    expect(fake.statements.at(-1)).toBe('ROLLBACK')
  })

  it('returns the primary keys of inserted rows for the rollback script', async () => {
    const fake = new FakePostgres().on(/^INSERT/, pgRows([{ id: '41' }, { id: '42' }]))
    const result = await adapterWith(fake).executeChange(
      approved("INSERT INTO accounts (status) VALUES ('a'), ('b')", 2),
    )
    expect(fake.statements[3]).toBe(
      'INSERT INTO "accounts" ("status") VALUES (\'a\'), (\'b\') RETURNING "id"',
    )
    expect(result).toEqual({
      ok: true,
      value: { affectedRows: 2, insertId: null, insertedKeys: [{ id: '41' }, { id: '42' }] },
    })
  })
})
