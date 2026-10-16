/**
 * Approved changes against a real MySQL (TICKETSMITH_TEST_MYSQL_URL; skipped otherwise): the only
 * write path commits on the expected row count, rolls back on any other, leaves the pooled session
 * read-only, and the generated rollback script restores the data.
 */
import { createConnection } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ApprovedChange,
  type GuardedQuery,
  guardChange,
  guardReadQuery,
  preflightChange,
  type TableInfo,
} from '#src/core/database/index.ts'
import {
  createMysqlConnectionSource,
  MysqlDatabaseAdapter,
} from '#src/core/database/providers/mysql/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'

const url = process.env['TICKETSMITH_TEST_MYSQL_URL']
const SCHEMA = 'ticketsmith_changes_it'
const parsed = url === undefined ? null : new URL(url)
const server = {
  host: parsed?.hostname ?? '127.0.0.1',
  port: Number(parsed?.port || 3306),
  user: decodeURIComponent(parsed?.username ?? 'root'),
  password: decodeURIComponent(parsed?.password ?? ''),
}
const admin = () => createConnection({ ...server, multipleStatements: true })

/** Approval is a CLI concern; here the test stands in for the human. */
const approved = (change: ApprovedChange['change'], expectedRows: number) =>
  ({ change, expectedRows }) as unknown as ApprovedChange
const forged = (sql: string): GuardedQuery => ({ sql, maxRows: 50 }) as GuardedQuery

describe.skipIf(url === undefined)('approved changes against a real MySQL', () => {
  const adapter = new MysqlDatabaseAdapter({
    name: 'it',
    source: createMysqlConnectionSource({ ...server, database: SCHEMA, ssl: false }),
    logger: createLogger({ level: 'silent' }),
    timeoutMs: 3_000,
  })
  let tables: readonly TableInfo[] = []

  const statusOf = async (id: number) => {
    const query = guardReadQuery(`SELECT status, note FROM accounts WHERE id = ${id}`, {
      dialect: 'mysql',
      maxRows: 5,
    })
    if (!query.ok) throw new Error(query.error.reason)
    const result = await adapter.runReadQuery(query.value)
    if (!result.ok) throw new Error(result.error.kind)
    return result.value.rows[0]
  }
  const guarded = (sql: string) => {
    const result = guardChange(sql, { tables })
    if (!result.ok) throw new Error(result.error.reason)
    return result.value
  }

  beforeAll(async () => {
    const connection = await admin()
    await connection.query(`
      DROP DATABASE IF EXISTS ${SCHEMA};
      CREATE DATABASE ${SCHEMA};
      USE ${SCHEMA};
      CREATE TABLE accounts (id INT PRIMARY KEY, email VARCHAR(100), status VARCHAR(20), note VARCHAR(100), KEY (email));
      CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, account_id INT, body VARCHAR(100));
      INSERT INTO accounts VALUES (1, 'a@x.mx', 'active', NULL), (2, 'b@x.mx', 'active', 'it''s'), (3, 'c@x.mx', 'active', NULL);
    `)
    await connection.end()
    const schema = await adapter.introspect()
    if (!schema.ok) throw new Error(schema.error.kind)
    tables = schema.value.tables
  })
  afterAll(async () => {
    await adapter[Symbol.asyncDispose]()
    const connection = await admin()
    await connection.query(`DROP DATABASE IF EXISTS ${SCHEMA}`)
    await connection.end()
  })

  it('commits when MySQL reports the approved row count, and the rollback script restores it', async () => {
    const change = guarded(
      "UPDATE accounts SET status = 'inactive', note = 'closed' WHERE id IN (1, 2)",
    )
    const preflight = await preflightChange(adapter, change, { maxRows: 100, changeId: 'cr-it' })
    if (!preflight.ok) throw new Error(preflight.error)
    expect(preflight.value.rows).toBe(2)
    expect(preflight.value.usesIndex).toBe(true)

    expect(await adapter.executeChange(approved(change, 2))).toEqual({
      ok: true,
      value: { affectedRows: 2, insertId: null },
    })
    expect(await statusOf(2)).toEqual({ status: 'inactive', note: 'closed' })

    // A person runs the script by hand; here: the generated UPDATEs only.
    const connection = await admin()
    await connection.query(`USE ${SCHEMA}`)
    for (const line of (preflight.value.rollbackSql ?? '')
      .split('\n')
      .filter((l) => l.startsWith('UPDATE'))) {
      await connection.query(line)
    }
    await connection.end()
    expect(await statusOf(1)).toEqual({ status: 'active', note: null })
    expect(await statusOf(2)).toEqual({ status: 'active', note: "it's" })
  })

  it('rolls back when the affected rows differ from the approval', async () => {
    const change = guarded("UPDATE accounts SET status = 'gone' WHERE status = 'active'")
    expect(await adapter.executeChange(approved(change, 1))).toEqual({
      ok: false,
      error: { kind: 'row-mismatch', database: 'it', expected: 1, actual: 3 },
    })
    expect(await statusOf(3)).toEqual({ status: 'active', note: null })
  })

  it('reports the AUTO_INCREMENT ids of an INSERT', async () => {
    const change = guarded("INSERT INTO notes (account_id, body) VALUES (1, 'a'), (2, 'b')")
    const result = await adapter.executeChange(approved(change, 2))
    expect(result.ok && result.value.affectedRows).toBe(2)
    expect(result.ok && result.value.insertId).toBeGreaterThan(0)
  })

  it('leaves pooled sessions read-only after a change', async () => {
    const change = guarded("UPDATE accounts SET note = 'x' WHERE id = 3")
    expect((await adapter.executeChange(approved(change, 1))).ok).toBe(true)
    // Both pool connections: a forged write through the read path is still refused by MySQL.
    for (let i = 0; i < 2; i++) {
      const write = await adapter.runReadQuery(
        forged("UPDATE accounts SET note = 'forged' WHERE id = 3"),
      )
      expect(write.ok).toBe(false)
    }
    expect(await statusOf(3)).toEqual({ status: 'active', note: 'x' })
  })
})
