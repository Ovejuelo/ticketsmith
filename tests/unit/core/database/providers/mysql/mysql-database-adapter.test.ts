import { describe, expect, it } from 'vitest'
import { guardReadQuery } from '#src/core/database/index.ts'
import { MysqlDatabaseAdapter } from '#src/core/database/providers/mysql/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'
import { FakeMysql, mysqlErrors } from '#tests/support/fake-mysql.ts'

const adapterWith = (fake: FakeMysql) =>
  new MysqlDatabaseAdapter({
    name: 'shard1',
    source: fake,
    logger: createLogger({ level: 'silent' }),
    timeoutMs: 15_000,
    clock: () => 0,
  })

const guarded = (sql: string, maxRows = 2) => {
  const result = guardReadQuery(sql, { dialect: 'mysql', maxRows })
  if (!result.ok) throw new Error(result.error.reason)
  return result.value
}

describe('MysqlDatabaseAdapter.runReadQuery', () => {
  it('runs in a read-only session and a time-limited READ ONLY transaction, always rolled back', async () => {
    const fake = new FakeMysql().rows(/FROM `users`/, [{ id: 1 }])
    const result = await adapterWith(fake).runReadQuery(guarded('SELECT id FROM users'))

    expect(result).toEqual({
      ok: true,
      value: { columns: ['id'], rows: [{ id: 1 }], truncated: false, elapsedMs: 0 },
    })
    expect(fake.statements).toEqual([
      'SET SESSION MAX_EXECUTION_TIME = 15000, transaction_read_only = ON',
      'START TRANSACTION READ ONLY',
      'SELECT `id` FROM `users` LIMIT 3',
      'ROLLBACK',
    ])
    expect(fake.released).toBe(1)
  })

  it('reports truncation when more than maxRows came back', async () => {
    const fake = new FakeMysql().rows(/FROM `t`/, [{ a: 1 }, { a: 2 }, { a: 3 }])
    const result = await adapterWith(fake).runReadQuery(guarded('SELECT a FROM t'))
    expect(result).toMatchObject({
      ok: true,
      value: { rows: [{ a: 1 }, { a: 2 }], truncated: true },
    })
  })

  it('rolls back and releases even when the query fails', async () => {
    const fake = new FakeMysql().on(/FROM `t`/, mysqlErrors.timeout())
    const result = await adapterWith(fake).runReadQuery(guarded('SELECT a FROM t'))

    expect(result).toEqual({
      ok: false,
      error: { kind: 'timeout', database: 'shard1', seconds: 15 },
    })
    expect(fake.statements.at(-1)).toBe('ROLLBACK')
    expect(fake.released).toBe(1)
  })

  it.each([
    ['unreachable', mysqlErrors.refused(), { kind: 'unreachable', message: 'ECONNREFUSED' }],
    ['auth', mysqlErrors.auth(), { kind: 'auth' }],
    ['rejected-by-database', mysqlErrors.readOnly(), { kind: 'rejected-by-database' }],
  ])('maps %s errors', async (_, error, expected) => {
    const fake = new FakeMysql().on(/FROM `t`/, error)
    expect(await adapterWith(fake).runReadQuery(guarded('SELECT a FROM t'))).toMatchObject({
      ok: false,
      error: { database: 'shard1', ...expected },
    })
  })

  it('reports a connection failure without running anything', async () => {
    const fake = new FakeMysql()
    fake.connectError = mysqlErrors.refused()
    expect(await adapterWith(fake).ping()).toMatchObject({
      ok: false,
      error: { kind: 'unreachable' },
    })
    expect(fake.statements).toEqual([])
  })

  it('only accepts guarded queries (compile-time)', () => {
    const adapter = adapterWith(new FakeMysql())
    // @ts-expect-error raw SQL cannot reach the database: run it through guardReadQuery first
    void adapter.runReadQuery({ sql: 'DELETE FROM users', maxRows: 1 })
  })
})

describe('MysqlDatabaseAdapter.accountCanWrite', () => {
  it.each([
    ['GRANT SELECT ON `app`.* TO `me`@`%`', false],
    ['GRANT SELECT, INSERT, UPDATE ON `app`.* TO `me`@`%`', true],
    ['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`', true],
    ['GRANT USAGE ON *.* TO `me`@`%`', false],
  ])('%s → %s', async (grant, canWrite) => {
    const fake = new FakeMysql().rows(/SHOW GRANTS/, [{ 'Grants for me@%': grant }])
    expect(await adapterWith(fake).accountCanWrite()).toEqual({ ok: true, value: canWrite })
  })
})

describe('MysqlDatabaseAdapter.introspect', () => {
  it('assembles tables, columns, foreign keys and indexes', async () => {
    const fake = new FakeMysql()
      .rows(/information_schema.TABLES/, [
        { table_name: 'users', table_comment: '', table_rows: '42' },
      ])
      .rows(/information_schema.COLUMNS/, [
        {
          table_name: 'users',
          column_name: 'id',
          column_type: 'int',
          is_nullable: 'NO',
          column_key: 'PRI',
          column_default: null,
          column_comment: '',
        },
        {
          table_name: 'users',
          column_name: 'account_id',
          column_type: 'int',
          is_nullable: 'YES',
          column_key: 'MUL',
          column_default: null,
          column_comment: 'owner',
        },
      ])
      .rows(/KEY_COLUMN_USAGE/, [
        {
          table_name: 'users',
          column_name: 'account_id',
          referenced_table: 'accounts',
          referenced_column: 'id',
        },
      ])
      .rows(/STATISTICS/, [
        { table_name: 'users', index_name: 'PRIMARY', non_unique: 0, column_name: 'id' },
        {
          table_name: 'users',
          index_name: 'idx_account',
          non_unique: 1,
          column_name: 'account_id',
        },
      ])

    expect(await adapterWith(fake).introspect()).toEqual({
      ok: true,
      value: {
        tables: [
          {
            name: 'users',
            comment: '',
            estimatedRows: 42,
            columns: [
              { name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, comment: '' },
              {
                name: 'account_id',
                type: 'int',
                nullable: true,
                key: 'MUL',
                default: null,
                comment: 'owner',
              },
            ],
            foreignKeys: [
              { column: 'account_id', referencesTable: 'accounts', referencesColumn: 'id' },
            ],
            indexes: [
              { name: 'PRIMARY', columns: ['id'], unique: true },
              { name: 'idx_account', columns: ['account_id'], unique: false },
            ],
          },
        ],
      },
    })
    expect(fake.statements[1]).toBe('START TRANSACTION READ ONLY')
  })

  it('closes the pool on dispose', async () => {
    const fake = new FakeMysql()
    await adapterWith(fake)[Symbol.asyncDispose]()
    expect(fake.ended).toBe(true)
  })
})
