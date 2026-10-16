import { describe, expect, it } from 'vitest'
import { guardReadQuery } from '#src/core/database/readonly-guard.ts'

const guard = (sql: string, maxRows = 200) => guardReadQuery(sql, { dialect: 'mysql', maxRows })

const accepted = (sql: string) => {
  const result = guard(sql)
  if (!result.ok) throw new Error(`expected "${sql}" to pass, got: ${result.error.reason}`)
  return result.value
}

const rejection = (sql: string) => {
  const result = guard(sql)
  if (result.ok) throw new Error(`expected "${sql}" to be rejected, got: ${result.value.sql}`)
  return result.error
}

describe('guardReadQuery — accepted reads', () => {
  it.each([
    'SELECT id, email FROM users WHERE id = 1',
    'select * from users u join accounts a on a.user_id = u.id',
    'WITH recent AS (SELECT * FROM invoices) SELECT customer_id, COUNT(*) FROM recent GROUP BY customer_id',
    'SELECT * FROM t WHERE id IN (SELECT t_id FROM u WHERE EXISTS (SELECT 1 FROM v WHERE v.u_id = u.id))',
    'SELECT 1 UNION ALL SELECT 2',
    "SELECT JSON_EXTRACT(data, '$.a') FROM t WHERE created_at >= NOW() - INTERVAL 7 DAY",
    'SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC) rn FROM payments',
    "SELECT CASE WHEN status = 'paid' THEN 1 ELSE 0 END AS paid FROM `order`",
    "SELECT * FROM users WHERE email LIKE '%@northwind.mx'",
    'SELECT * FROM users -- trailing note',
    'SELECT * FROM users # hash comment',
    'SELECT * FROM users /* plain comment */ WHERE id = 1',
    "SELECT 'it''s', 'a\\'b' FROM DUAL",
  ])('accepts %s', (sql) => {
    accepted(sql)
  })

  it('executes the SQL regenerated from the validated tree, not the raw text', () => {
    expect(accepted('select id from users /* note */ where id = 1').sql).toBe(
      'SELECT `id` FROM `users` WHERE `id` = 1 LIMIT 201',
    )
  })

  it('adds a LIMIT of maxRows + 1 so truncation can be reported', () => {
    expect(accepted('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM `users` LIMIT 201',
      maxRows: 200,
    })
  })

  it('keeps a LIMIT within the cap', () => {
    expect(accepted('SELECT * FROM users LIMIT 50').sql).toBe('SELECT * FROM `users` LIMIT 50')
    expect(accepted('SELECT * FROM users LIMIT 10, 5').sql).toBe(
      'SELECT * FROM `users` LIMIT 10, 5',
    )
    expect(accepted('SELECT * FROM users LIMIT 5 OFFSET 10').sql).toBe(
      'SELECT * FROM `users` LIMIT 5 OFFSET 10',
    )
  })

  it('limits a UNION as a whole', () => {
    expect(accepted('SELECT a FROM t UNION SELECT a FROM u').sql).toMatch(/LIMIT 201$/)
  })

  it('a trailing -- comment can never swallow the LIMIT', () => {
    expect(accepted('SELECT * FROM users -- note').sql).toBe('SELECT * FROM `users` LIMIT 201')
  })
})

describe('guardReadQuery — rejected', () => {
  it.each([
    ['UPDATE users SET a = 1', /only a single SELECT/i],
    ['DELETE FROM users', /only a single SELECT/i],
    ['INSERT INTO t VALUES (1)', /only a single SELECT/i],
    ['INSERT INTO t SELECT * FROM u', /only a single SELECT/i],
    ['REPLACE INTO t VALUES (1)', /only a single SELECT/i],
    ['CREATE TABLE x (a int)', /only a single SELECT/i],
    ['DROP TABLE t', /only a single SELECT/i],
    ['ALTER TABLE t ADD c int', /only a single SELECT|could not be parsed/i],
    ['TRUNCATE TABLE t', /only a single SELECT|could not be parsed/i],
    ['SET @x = 1', /only a single SELECT/i],
    ['CALL p()', /only a single SELECT/i],
    ["LOAD DATA INFILE '/x' INTO TABLE t", /only a single SELECT/i],
    ['GRANT ALL ON *.* TO x', /only a single SELECT/i],
    ['LOCK TABLES t READ', /only a single SELECT/i],
    ['SHOW TABLES', /only a single SELECT/i],
    ['EXPLAIN SELECT 1', /only a single SELECT/i],
    ['DO SLEEP(1)', /could not be parsed/i],
    ['HANDLER t OPEN', /could not be parsed/i],
    ['SELECT 1; SELECT 2', /exactly one statement/i],
    ['SELECT * FROM t WHERE a = "x"; DELETE FROM t', /exactly one statement/i],
    ['SELECT 1 # comment\n; DELETE FROM t', /exactly one statement/i],
    ["SELECT * FROM users INTO OUTFILE '/tmp/x'", /INTO/],
    ['SELECT 1 INTO DUMPFILE "/tmp/x"', /INTO/],
    ['SELECT id INTO @v FROM users LIMIT 1', /INTO/],
    ['SELECT * FROM users FOR UPDATE', /lock/i],
    ['SELECT * FROM t WHERE a = 1 FOR UPDATE NOWAIT', /lock/i],
    ['SELECT * FROM users LOCK IN SHARE MODE', /lock/i],
    ['SELECT * FROM t FOR SHARE', /could not be parsed|lock/i],
    ['SELECT @a := 1', /variable|assign/i],
    ['SELECT x FROM t WHERE id = @v', /variable/i],
    ['SELECT @@version', /variable/i],
    ['SELECT SLEEP(10)', /SLEEP/],
    ['select benchmark(1000000, md5(1))', /BENCHMARK/],
    ['SELECT LOAD_FILE("/etc/passwd")', /LOAD_FILE/],
    ["SELECT GET_LOCK('x', 10)", /GET_LOCK/],
    ['SELECT (SELECT SLEEP(1)) AS x', /SLEEP/],
    ['SELECT * FROM t WHERE id IN (SELECT SLEEP(1))', /SLEEP/],
    ['WITH x AS (SELECT SLEEP(1)) SELECT * FROM x', /SLEEP/],
    ['SELECT 1 UNION SELECT SLEEP(2)', /SLEEP/],
    ['(SELECT 1) UNION (SELECT SLEEP(2))', /SLEEP/],
    ['SELECT `sleep`(1)', /SLEEP/],
    ['SELECT /*!50000 SLEEP(1) */ 1', /executable comment/i],
    ['SELECT /*M! SLEEP(1) */ 1', /executable comment/i],
    ['SELECT /*+ MAX_EXECUTION_TIME(999999) */ * FROM t', /optimizer hint/i],
    ['SELECT 1 --1, SLEEP(10)', /--/],
    ['SELECT 1\u0000', /null byte/i],
    ['SELEC 1', /could not be parsed/i],
    ['', /empty/i],
    ['SELECT * FROM users LIMIT 5000', /LIMIT/],
    ['SELECT * FROM users LIMIT 10, 5000', /LIMIT/],
  ])('rejects %j', (sql, reason) => {
    expect(rejection(sql).reason).toMatch(reason)
  })

  it('does not treat comment markers inside strings as comments', () => {
    accepted("SELECT * FROM t WHERE note = '/*!50000 x */ --1'")
  })
})
