/**
 * The behavior every DatabaseAdapter must show against its real engine. Each engine's integration
 * test describes how to reach and seed it, then calls `adapterContract`. The seeded schema is the
 * same for every engine: accounts, users (FK to accounts) and notes (generated ids).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ApprovedChange,
  type DatabaseAdapter,
  type Dialect,
  type GuardedQuery,
  guardChange,
  guardReadQuery,
  insertRollback,
  preflightChange,
  type TableInfo,
} from '#src/core/database/index.ts'

export type ContractEngine = {
  readonly label: string
  readonly dialect: Dialect
  /** False when the engine's env var is unset: the suite is skipped. */
  readonly available: boolean
  /** Drops and creates the test schema, its tables and rows, and a read-only account. */
  reset(): Promise<void>
  drop(): Promise<void>
  adapter(options?: {
    readonly reader?: boolean
    readonly timeoutMs?: number
    readonly unreachable?: boolean
  }): DatabaseAdapter
  /** Runs SQL as the admin inside the test schema, outside Ticketsmith. */
  admin(sql: string): Promise<readonly Record<string, unknown>[]>
  /** A forged statement that waits `seconds`, to prove the time limit. */
  readonly sleepSql: (seconds: number) => string
  /** A forged statement that tries to switch the read-only protection off. */
  readonly switchOffSql: string
}

/** Skips the guard on purpose: proves the engine itself refuses what a guard bug might let through. */
const forged = (sql: string): GuardedQuery => ({ sql, maxRows: 50 }) as GuardedQuery

/** Approval is a CLI concern; here the test stands in for the human. */
const approved = (change: ApprovedChange['change'], expectedRows: number) =>
  ({ change, expectedRows }) as unknown as ApprovedChange

export const adapterContract = (engine: ContractEngine): void => {
  describe.skipIf(!engine.available)(`${engine.label}: DatabaseAdapter contract`, () => {
    let adapter: DatabaseAdapter
    let tables: readonly TableInfo[] = []

    const read = (sql: string, maxRows = 50) => {
      const result = guardReadQuery(sql, { dialect: engine.dialect, maxRows })
      if (!result.ok) throw new Error(result.error.reason)
      return result.value
    }
    const change = (sql: string) => {
      const result = guardChange(sql, { dialect: engine.dialect, tables })
      if (!result.ok) throw new Error(result.error.reason)
      return result.value
    }
    const account = async (id: number) => {
      const result = await adapter.runReadQuery(
        read(`SELECT status, note FROM accounts WHERE id = ${id}`),
      )
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      return result.value.rows[0]
    }

    beforeAll(async () => {
      await engine.reset()
      adapter = engine.adapter()
      const schema = await adapter.introspect()
      if (!schema.ok) throw new Error(JSON.stringify(schema.error))
      tables = schema.value.tables
    })
    afterAll(async () => {
      await adapter[Symbol.asyncDispose]()
      await engine.drop()
    })

    it('runs guarded reads: joins, CTEs, subqueries and truncation', async () => {
      const joined = await adapter.runReadQuery(
        read(
          `WITH northwind AS (SELECT id FROM accounts WHERE name = 'Northwind')
           SELECT u.email, a.name FROM users u JOIN accounts a ON a.id = u.account_id
           WHERE a.id IN (SELECT id FROM northwind) ORDER BY u.id`,
        ),
      )
      expect(joined).toMatchObject({
        ok: true,
        value: {
          columns: ['email', 'name'],
          rows: [
            { email: 'ana@northwind.mx', name: 'Northwind' },
            { email: 'luis@northwind.mx', name: 'Northwind' },
          ],
          truncated: false,
        },
      })
      expect(await adapter.runReadQuery(read('SELECT id FROM users ORDER BY id', 2))).toMatchObject(
        { ok: true, value: { rows: [{ id: 1 }, { id: 2 }], truncated: true } },
      )
    })

    it('introspects tables, columns, comments, foreign keys and indexes', async () => {
      const schema = await adapter.introspect()
      if (!schema.ok) throw new Error(JSON.stringify(schema.error))
      const { tables } = schema.value
      expect(tables.map((table) => table.name)).toEqual(['accounts', 'notes', 'users'])
      const accounts = tables.find((table) => table.name === 'accounts')
      expect(accounts?.columns.find((c) => c.name === 'id')).toMatchObject({
        key: 'PRI',
        nullable: false,
      })
      expect(accounts?.columns.find((c) => c.name === 'name')).toMatchObject({
        comment: 'Customer name',
      })
      const users = tables.find((table) => table.name === 'users')
      expect(users?.foreignKeys).toEqual([
        { column: 'account_id', referencesTable: 'accounts', referencesColumn: 'id' },
      ])
      expect(users?.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'idx_account', columns: ['account_id'], unique: false }),
          expect.objectContaining({ columns: ['email'], unique: true }),
        ]),
      )
    })

    it('tells a write-capable account from a read-only one', async () => {
      expect(await adapter.accountCanWrite()).toEqual({ ok: true, value: true })
      const reader = engine.adapter({ reader: true })
      expect(await reader.accountCanWrite()).toEqual({ ok: true, value: false })
      await reader[Symbol.asyncDispose]()
    })

    it.each([
      ["UPDATE users SET email = 'x@x.com' WHERE id = 1"],
      ["INSERT INTO accounts (id, name) VALUES (9, 'Evil')"],
      ['DELETE FROM users WHERE id = 3'],
      ['CREATE TABLE evil (a INT)'],
      ['DROP TABLE notes'],
      ['TRUNCATE TABLE notes'],
      ['ALTER TABLE users ADD COLUMN evil INT'],
    ])('the engine itself refuses a forged write the guard would never pass: %s', async (sql) => {
      expect(await adapter.runReadQuery(forged(sql))).toMatchObject({
        ok: false,
        error: { kind: 'rejected-by-database' },
      })
    })

    it('a forged read-only switch-off does not survive into the next call', async () => {
      await adapter.runReadQuery(forged(engine.switchOffSql))
      for (let call = 0; call < 3; call++) {
        expect(
          await adapter.runReadQuery(forged(`CREATE TABLE evil_${call} (a INT)`)),
        ).toMatchObject({ ok: false, error: { kind: 'rejected-by-database' } })
      }
    })

    it('refuses statement batches', async () => {
      expect((await adapter.runReadQuery(forged('SELECT 1; DROP TABLE users'))).ok).toBe(false)
    })

    it('left every table and row untouched by the refused statements', async () => {
      expect(await engine.admin('SELECT id, email FROM users ORDER BY id')).toEqual([
        { id: 1, email: 'ana@northwind.mx' },
        { id: 2, email: 'luis@northwind.mx' },
        { id: 3, email: 'eva@contoso.mx' },
      ])
      const schema = await adapter.introspect()
      expect(schema.ok && schema.value.tables.length).toBe(3)
    })

    it('stops queries at the time limit', async () => {
      const quick = engine.adapter({ timeoutMs: 1_000 })
      const result = await quick.runReadQuery(forged(engine.sleepSql(5)))
      await quick[Symbol.asyncDispose]()
      if (result.ok) {
        // MySQL interrupts SLEEP inside MAX_EXECUTION_TIME by returning early instead of an error.
        expect(result.value.elapsedMs).toBeLessThan(4_000)
      } else {
        expect(result.error.kind).toBe('timeout')
      }
    })

    it('reports an unreachable server', async () => {
      const nowhere = engine.adapter({ unreachable: true })
      expect(await nowhere.ping()).toMatchObject({ ok: false, error: { kind: 'unreachable' } })
      await nowhere[Symbol.asyncDispose]()
    })

    it('commits an approved change on the expected row count; its rollback script restores the rows', async () => {
      const update = change(
        "UPDATE accounts SET status = 'inactive', note = 'closed' WHERE id IN (1, 2)",
      )
      const preflight = await preflightChange(adapter, update, {
        maxRows: 100,
        changeId: 'cr-it',
      })
      if (!preflight.ok) throw new Error(preflight.error)
      expect(preflight.value.rows).toBe(2)

      expect(await adapter.executeChange(approved(update, 2))).toMatchObject({
        ok: true,
        value: { affectedRows: 2 },
      })
      expect(await account(2)).toEqual({ status: 'inactive', note: 'closed' })

      // A person runs the script by hand; here: its UPDATEs only.
      for (const line of (preflight.value.rollbackSql ?? '').split('\n')) {
        if (line.startsWith('UPDATE')) await engine.admin(line)
      }
      expect(await account(1)).toEqual({ status: 'active', note: null })
      expect(await account(2)).toEqual({ status: 'active', note: "it's" })
    })

    it('rolls an approved change back when the affected rows differ', async () => {
      const update = change("UPDATE accounts SET status = 'gone' WHERE status = 'active'")
      expect(await adapter.executeChange(approved(update, 1))).toEqual({
        ok: false,
        error: { kind: 'row-mismatch', database: 'it', expected: 1, actual: 3 },
      })
      expect(await account(3)).toEqual({ status: 'active', note: null })
    })

    it('knows the keys of inserted rows, so the rollback script can name them', async () => {
      const insert = change("INSERT INTO notes (account_id, body) VALUES (1, 'a'), (2, 'b')")
      const result = await adapter.executeChange(approved(insert, 2))
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      expect(result.value.affectedRows).toBe(2)
      const keys =
        result.value.insertedKeys ??
        (result.value.insertId === null
          ? null
          : [{ id: result.value.insertId }, { id: result.value.insertId + 1 }])
      expect(keys).toHaveLength(2)
      const ids = (await engine.admin('SELECT id FROM notes ORDER BY id')).map((row) =>
        String(row['id']),
      )
      expect(keys?.map((key) => String(key['id']))).toEqual(ids)
      expect(insertRollback(insert, keys, 'cr-it')).toContain('DELETE FROM')
    })

    it('leaves pooled sessions read-only after a change', async () => {
      const update = change("UPDATE accounts SET note = 'x' WHERE id = 3")
      expect((await adapter.executeChange(approved(update, 1))).ok).toBe(true)
      for (let i = 0; i < 2; i++) {
        const write = await adapter.runReadQuery(
          forged("UPDATE accounts SET note = 'forged' WHERE id = 3"),
        )
        expect(write).toMatchObject({ ok: false, error: { kind: 'rejected-by-database' } })
      }
      expect(await account(3)).toEqual({ status: 'active', note: 'x' })
    })
  })
}
