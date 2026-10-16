/**
 * Runs against a real MySQL when TICKETSMITH_TEST_MYSQL_URL is set (see `pnpm mysql:up` and
 * `pnpm test:integration`); skipped otherwise. It uses its own schema, created and dropped here.
 */
import { createConnection } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type GuardedQuery, guardReadQuery } from '#src/core/database/index.ts'
import {
  createMysqlConnectionSource,
  MysqlDatabaseAdapter,
} from '#src/core/database/providers/mysql/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'

const url = process.env['TICKETSMITH_TEST_MYSQL_URL']
const SCHEMA = 'ticketsmith_it'

const parsed = url === undefined ? null : new URL(url)
const server = {
  host: parsed?.hostname ?? '127.0.0.1',
  port: Number(parsed?.port || 3306),
  user: decodeURIComponent(parsed?.username ?? 'root'),
  password: decodeURIComponent(parsed?.password ?? ''),
}

const admin = () => createConnection({ ...server, multipleStatements: true })

const adapterFor = (user = server.user, password = server.password, timeoutMs = 3_000) =>
  new MysqlDatabaseAdapter({
    name: 'it',
    source: createMysqlConnectionSource({
      ...server,
      user,
      password,
      database: SCHEMA,
      ssl: false,
    }),
    logger: createLogger({ level: 'silent' }),
    timeoutMs,
  })

const guarded = (sql: string, maxRows = 50): GuardedQuery => {
  const result = guardReadQuery(sql, { dialect: 'mysql', maxRows })
  if (!result.ok) throw new Error(result.error.reason)
  return result.value
}

/** Skips the guard on purpose: proves MySQL itself refuses what a guard bug might let through. */
const forged = (sql: string): GuardedQuery => ({ sql, maxRows: 50 }) as GuardedQuery

describe.skipIf(url === undefined)('MysqlDatabaseAdapter against a real MySQL', () => {
  const adapter = adapterFor()

  beforeAll(async () => {
    const connection = await admin()
    await connection.query(`
      DROP DATABASE IF EXISTS ${SCHEMA};
      CREATE DATABASE ${SCHEMA};
      USE ${SCHEMA};
      CREATE TABLE accounts (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL COMMENT 'Customer name');
      CREATE TABLE users (
        id INT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        account_id INT NOT NULL,
        settings JSON,
        KEY idx_account (account_id),
        CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts (id)
      );
      INSERT INTO accounts VALUES (1, 'Northwind'), (2, 'Contoso');
      INSERT INTO users VALUES
        (1, 'ana@northwind.mx', 1, '{"role": "owner"}'),
        (2, 'luis@northwind.mx', 1, NULL),
        (3, 'eva@contoso.mx', 2, '{"role": "admin"}');
      DROP USER IF EXISTS 'ts_reader'@'%';
      CREATE USER 'ts_reader'@'%' IDENTIFIED BY 'reader-pw';
      GRANT SELECT ON ${SCHEMA}.* TO 'ts_reader'@'%';
    `)
    await connection.end()
  })

  afterAll(async () => {
    await adapter[Symbol.asyncDispose]()
    const connection = await admin()
    await connection.query(
      `DROP DATABASE IF EXISTS ${SCHEMA}; DROP USER IF EXISTS 'ts_reader'@'%';`,
    )
    await connection.end()
  })

  it('runs guarded reads: joins, CTEs, JSON and truncation', async () => {
    const joined = await adapter.runReadQuery(
      guarded(
        `WITH northwind AS (SELECT id FROM accounts WHERE name = 'Northwind')
         SELECT u.email, a.name, JSON_UNQUOTE(JSON_EXTRACT(u.settings, '$.role')) AS role
         FROM users u JOIN accounts a ON a.id = u.account_id WHERE a.id IN (SELECT id FROM northwind) ORDER BY u.id`,
      ),
    )
    expect(joined).toMatchObject({
      ok: true,
      value: {
        columns: ['email', 'name', 'role'],
        rows: [
          { email: 'ana@northwind.mx', name: 'Northwind', role: 'owner' },
          { email: 'luis@northwind.mx', name: 'Northwind', role: null },
        ],
        truncated: false,
      },
    })

    const truncated = await adapter.runReadQuery(guarded('SELECT id FROM users ORDER BY id', 2))
    expect(truncated).toMatchObject({
      ok: true,
      value: { rows: [{ id: 1 }, { id: 2 }], truncated: true },
    })
  })

  it('introspects tables, columns, foreign keys and indexes', async () => {
    const schema = await adapter.introspect()
    if (!schema.ok) throw new Error(JSON.stringify(schema.error))
    const users = schema.value.tables.find((table) => table.name === 'users')
    expect(schema.value.tables.map((table) => table.name)).toEqual(['accounts', 'users'])
    expect(users?.foreignKeys).toEqual([
      { column: 'account_id', referencesTable: 'accounts', referencesColumn: 'id' },
    ])
    expect(users?.indexes.map((index) => [index.name, index.unique])).toEqual(
      expect.arrayContaining([
        ['PRIMARY', true],
        ['email', true],
        ['idx_account', false],
      ]),
    )
    expect(schema.value.tables[0]?.columns[1]).toMatchObject({
      name: 'name',
      comment: 'Customer name',
    })
  })

  it('tells a write-capable account from a read-only one', async () => {
    expect(await adapter.accountCanWrite()).toEqual({ ok: true, value: true })
    const reader = adapterFor('ts_reader', 'reader-pw')
    expect(await reader.accountCanWrite()).toEqual({ ok: true, value: false })
    await reader[Symbol.asyncDispose]()
  })

  it.each([
    ["UPDATE users SET email = 'x@x.com' WHERE id = 1"],
    ['INSERT INTO accounts VALUES (9, "Evil")'],
    ['DELETE FROM users WHERE id = 3'],
    ['CREATE TABLE evil (a INT)'],
    ['DROP TABLE users'],
    ['TRUNCATE TABLE users'],
    ['ALTER TABLE users ADD COLUMN evil INT'],
  ])('MySQL itself refuses a forged write the guard would never pass: %s', async (sql) => {
    const result = await adapter.runReadQuery(forged(sql))
    expect(result).toMatchObject({ ok: false, error: { kind: 'rejected-by-database' } })
  })

  it('a forged read-only switch-off does not survive into the next call', async () => {
    // MySQL accepts SET transaction_read_only = OFF inside a session, so the protection is that each
    // call runs exactly one statement and re-enables read-only mode before it.
    await adapter.runReadQuery(forged('SET SESSION transaction_read_only = OFF'))
    for (let call = 0; call < 3; call++) {
      expect(await adapter.runReadQuery(forged(`CREATE TABLE evil_${call} (a INT)`))).toMatchObject(
        {
          ok: false,
          error: { kind: 'rejected-by-database' },
        },
      )
    }
  })

  it('refuses statement batches at the server', async () => {
    expect((await adapter.runReadQuery(forged('SELECT 1; DROP TABLE users'))).ok).toBe(false)
  })

  it('left every table and row untouched', async () => {
    const connection = await admin()
    const [tables] = await connection.query(`SHOW TABLES FROM ${SCHEMA}`)
    const [rows] = await connection.query(`SELECT id, email FROM ${SCHEMA}.users ORDER BY id`)
    await connection.end()
    expect((tables as object[]).length).toBe(2)
    expect(rows).toEqual([
      { id: 1, email: 'ana@northwind.mx' },
      { id: 2, email: 'luis@northwind.mx' },
      { id: 3, email: 'eva@contoso.mx' },
    ])
  })

  it('stops queries at the time limit', async () => {
    const quick = adapterFor(server.user, server.password, 1_000)
    const result = await quick.runReadQuery(forged('SELECT SLEEP(5) AS s FROM users'))
    await quick[Symbol.asyncDispose]()
    if (result.ok) {
      // MySQL interrupts SLEEP inside MAX_EXECUTION_TIME by returning 1 early instead of an error.
      expect(result.value.elapsedMs).toBeLessThan(4_000)
    } else {
      expect(result.error.kind).toBe('timeout')
    }
  })

  it('reports an unreachable server', async () => {
    const nowhere = new MysqlDatabaseAdapter({
      name: 'nowhere',
      source: createMysqlConnectionSource({ ...server, port: 1, database: SCHEMA, ssl: false }),
      logger: createLogger({ level: 'silent' }),
    })
    expect(await nowhere.ping()).toMatchObject({ ok: false, error: { kind: 'unreachable' } })
    await nowhere[Symbol.asyncDispose]()
  })
})
