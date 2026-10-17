import { describe, expect, it } from 'vitest'
import type { TableInfo } from '#src/core/database/index.ts'
import { guardChange } from '#src/core/database/write-guard.ts'

const column = (name: string, key = '', nullable = true) => ({
  name,
  type: 'varchar(255)',
  nullable,
  key,
  default: null,
  comment: '',
})

const table = (name: string, columns: TableInfo['columns']): TableInfo => ({
  name,
  comment: '',
  estimatedRows: 100,
  columns,
  foreignKeys: [],
  indexes: [],
})

const TABLES: readonly TableInfo[] = [
  table('accounts', [
    column('id', 'PRI', false),
    column('email', 'UNI', false),
    column('status'),
    column('balance'),
    column('updated_at'),
  ]),
  table('notes', [column('id', 'PRI', false), column('account_id', 'MUL'), column('body')]),
  table('memberships', [
    column('account_id', 'PRI', false),
    column('group_id', 'PRI', false),
    column('role'),
  ]),
  table('logs', [column('message'), column('created_at')]),
  table('order', [column('id', 'PRI', false), column('status')]),
]

const guard = (sql: string) => guardChange(sql, { dialect: 'mysql', tables: TABLES })

const accepted = (sql: string) => {
  const result = guard(sql)
  if (!result.ok) throw new Error(`expected "${sql}" to pass, got: ${result.error.reason}`)
  return result.value
}

const rejection = (sql: string) => {
  const result = guard(sql)
  if (result.ok) throw new Error(`expected "${sql}" to be rejected, got: ${result.value.sql}`)
  return result.error.reason
}

describe('guardChange — accepted changes', () => {
  it('accepts a targeted UPDATE and runs the regenerated SQL', () => {
    const change = accepted(
      "update accounts set status = 'inactive', updated_at = NOW() where id = 7 and status = 'active'",
    )
    expect(change).toMatchObject({
      kind: 'update',
      table: 'accounts',
      primaryKey: ['id'],
      columns: ['status', 'updated_at'],
      whereSql: "`id` = 7 AND `status` = 'active'",
    })
    expect(change.sql).toBe(
      "UPDATE `accounts` SET `status` = 'inactive', `updated_at` = NOW() WHERE `id` = 7 AND `status` = 'active'",
    )
  })

  it.each([
    "UPDATE accounts SET status = 'x' WHERE email IN ('a@x.mx', 'b@x.mx')",
    "UPDATE accounts SET status = 'x' WHERE id = 1 AND (balance > 0 OR status IS NULL)",
    'UPDATE accounts SET balance = balance + 10 WHERE id = 3',
    "UPDATE accounts SET status = NULL, email = LOWER(TRIM(' A@X.MX ')) WHERE id = 3",
    "UPDATE `order` SET status = 'paid' WHERE id = 1",
    "UPDATE accounts SET status = 'x' WHERE accounts.id = 1",
    "UPDATE accounts SET status = 'x' WHERE id = -1",
  ])('accepts %s', (sql) => {
    expect(accepted(sql).kind).toBe('update')
  })

  it('accepts an INSERT with explicit columns and literal rows', () => {
    const change = accepted(
      "INSERT INTO notes (account_id, body) VALUES (7, 'hi'), (8, CONCAT('a', 'b'))",
    )
    expect(change).toMatchObject({
      kind: 'insert',
      table: 'notes',
      primaryKey: ['id'],
      columns: ['account_id', 'body'],
      whereSql: null,
      insertRows: 2,
    })
    expect(change.sql).toBe(
      "INSERT INTO `notes` (`account_id`, `body`) VALUES (7,'hi'), (8,CONCAT('a', 'b'))",
    )
  })

  it('quotes reserved-word columns in the regenerated INSERT', () => {
    expect(accepted("INSERT INTO `order` (id, status) VALUES (1, 'new')").sql).toBe(
      "INSERT INTO `order` (`id`, `status`) VALUES (1,'new')",
    )
  })

  it('knows composite primary keys', () => {
    expect(
      accepted("UPDATE memberships SET role = 'admin' WHERE account_id = 1 AND group_id = 2")
        .primaryKey,
    ).toEqual(['account_id', 'group_id'])
  })
})

describe('guardChange — rejected changes', () => {
  it.each([
    ['DELETE FROM accounts WHERE id = 1', /DELETE is never allowed/],
    ["REPLACE INTO notes (id, body) VALUES (1, 'x')", /REPLACE/],
    ['DROP TABLE accounts', /Only a single INSERT … VALUES or UPDATE … WHERE/],
    ['TRUNCATE accounts', /Only a single INSERT/],
    ['ALTER TABLE accounts ADD COLUMN x INT', /Only a single INSERT/],
    ['SELECT * FROM accounts', /Only a single INSERT/],
    ['SET @a = 1', /Only a single INSERT/],
    [
      "UPDATE accounts SET status = 'x' WHERE id = 1; DELETE FROM accounts",
      /exactly one statement/,
    ],
    ['', /Empty/],
  ])('%s', (sql, reason) => {
    expect(rejection(sql)).toMatch(reason)
  })

  it.each([
    ["UPDATE accounts SET status = 'x'", /needs a WHERE/],
    ["UPDATE accounts SET status = 'x' WHERE 1 = 1", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE TRUE", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE id = id", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1 OR 1 = 1", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE id > 0", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE status IS NOT NULL", /WHERE must pin rows/],
    ["UPDATE accounts SET status = 'x' WHERE id IN (SELECT account_id FROM notes)", /Subqueries/],
    ['UPDATE accounts SET status = (SELECT body FROM notes LIMIT 1) WHERE id = 1', /Subqueries/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1 ORDER BY id LIMIT 1", /ORDER BY or LIMIT/],
    [
      "UPDATE accounts a JOIN notes n ON n.account_id = a.id SET a.status = 'x' WHERE a.id = 1",
      /one table/,
    ],
    ["UPDATE accounts, notes SET accounts.status = 'x' WHERE accounts.id = 1", /one table/],
    ["UPDATE other_db.accounts SET status = 'x' WHERE id = 1", /other databases/],
    ["UPDATE accounts SET status = 'x' WHERE id = @target", /variables/i],
    ['UPDATE accounts SET status = @@hostname WHERE id = 1', /variables/i],
    ['UPDATE accounts SET status = SLEEP(5) WHERE id = 1', /SLEEP\(\) is not allowed/],
    [
      "UPDATE accounts SET status = LOAD_FILE('/etc/passwd') WHERE id = 1",
      /LOAD_FILE\(\) is not allowed/,
    ],
    ['UPDATE accounts SET status = UUID() WHERE id = 1', /UUID\(\) is not allowed/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1 /*! AND SLEEP(5) */", /executable comments/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1 --1, status = 'y'", /"--"/],
    ["UPDATE ghosts SET status = 'x' WHERE id = 1", /Unknown table "ghosts"/],
    ["UPDATE accounts SET nickname = 'x' WHERE id = 1", /Unknown column "nickname" in accounts/],
    [
      "UPDATE accounts SET status = 'x' WHERE nickname = 'x'",
      /Unknown column "nickname" in accounts/,
    ],
    ["UPDATE logs SET message = 'x' WHERE message = 'y'", /no primary key/],
  ])('%s', (sql, reason) => {
    expect(rejection(sql)).toMatch(reason)
  })

  it.each([
    ["INSERT INTO notes VALUES (1, 7, 'x')", /explicit column list/],
    ['INSERT INTO notes (account_id) SELECT id FROM accounts', /INSERT … SELECT/],
    [
      "INSERT INTO notes (id, body) VALUES (1, 'x') ON DUPLICATE KEY UPDATE body = 'y'",
      /ON DUPLICATE KEY/,
    ],
    ["INSERT IGNORE INTO notes (body) VALUES ('x')", /IGNORE/],
    ['INSERT INTO notes (account_id, body) VALUES (1)', /column count doesn't match value count/],
    ['INSERT INTO notes (body) VALUES ((SELECT email FROM accounts LIMIT 1))', /Subqueries/],
    ['INSERT INTO notes (body) VALUES (SLEEP(1))', /SLEEP\(\) is not allowed/],
    ["INSERT INTO notes (nickname) VALUES ('x')", /Unknown column "nickname" in notes/],
    ["INSERT INTO logs (message) VALUES ('x')", /no primary key/],
  ])('%s', (sql, reason) => {
    expect(rejection(sql)).toMatch(reason)
  })
})

describe('guardChange — PostgreSQL', () => {
  const pg = (sql: string) => guardChange(sql, { dialect: 'postgres', tables: TABLES })
  const pgAccepted = (sql: string) => {
    const result = pg(sql)
    if (!result.ok) throw new Error(`expected "${sql}" to pass, got: ${result.error.reason}`)
    return result.value
  }
  const pgRejection = (sql: string) => {
    const result = pg(sql)
    if (result.ok) throw new Error(`expected "${sql}" to be rejected, got: ${result.value.sql}`)
    return result.error.reason
  }

  it('accepts a targeted UPDATE, folding unquoted names, with a reusable WHERE', () => {
    const change = pgAccepted(
      "UPDATE Accounts SET Status = 'inactive', updated_at = NOW() WHERE Id = 7 AND accounts.status = 'active'",
    )
    expect(change).toMatchObject({
      dialect: 'postgres',
      kind: 'update',
      table: 'accounts',
      primaryKey: ['id'],
      columns: ['status', 'updated_at'],
    })
    expect(change.sql).toBe(
      'UPDATE "accounts" SET Status = \'inactive\', updated_at = NOW() WHERE Id = 7 AND "accounts".status = \'active\'',
    )
    expect(change.whereSql).toBe('Id = 7 AND "accounts".status = \'active\'')
  })

  it('accepts an INSERT and quotes its columns the PostgreSQL way', () => {
    const change = pgAccepted(
      "INSERT INTO notes (account_id, Body) VALUES (7, 'hi'), (8, $$it's$$)",
    )
    expect(change).toMatchObject({ kind: 'insert', columns: ['account_id', 'body'], insertRows: 2 })
    expect(change.sql).toBe(
      'INSERT INTO "notes" ("account_id", "body") VALUES (7,\'hi\'), (8,$$it\'s$$)',
    )
    expect(pgAccepted('INSERT INTO "order" (id, status) VALUES (1, \'new\')').table).toBe('order')
  })

  it.each([
    ["INSERT INTO notes (account_id, body) VALUES (1, 'x') RETURNING id", /RETURNING/],
    ["INSERT INTO notes (id, body) VALUES (1, 'x') ON CONFLICT (id) DO NOTHING", /ON CONFLICT/],
    ["UPDATE accounts SET status = 'x' FROM notes WHERE accounts.id = notes.account_id", /FROM/],
    ["UPDATE accounts SET status = 'x' WHERE id = $1", /Parameters/],
    ["UPDATE accounts SET status = nextval('s') WHERE id = 1", /NEXTVAL\(\) is not allowed/],
    ["UPDATE accounts SET status = 'a\\' WHERE id = 1", /Backslashes/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1; DROP TABLE accounts", /exactly one/],
    ['DELETE FROM accounts WHERE id = 1', /DELETE is never allowed/],
    ["UPDATE accounts SET status = 'x'", /needs a WHERE/],
    ["UPDATE accounts SET status = 'x' WHERE id = 1 OR 1 = 1", /must pin rows/],
    ['UPDATE "Accounts" SET status = \'x\' WHERE id = 1', /Unknown table "Accounts"/],
    ["UPDATE accounts SET nope = 'x' WHERE id = 1", /Unknown column "nope"/],
    ['UPDATE accounts SET balance = nope + 1 WHERE id = 1', /Unknown column "nope"/],
  ])('rejects %s', (sql, reason) => {
    expect(pgRejection(sql)).toMatch(reason)
  })
})
