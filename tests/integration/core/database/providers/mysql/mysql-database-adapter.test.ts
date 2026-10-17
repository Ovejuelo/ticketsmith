/**
 * Runs against a real MySQL when TICKETSMITH_TEST_MYSQL_URL is set (see `pnpm mysql:up` and
 * `pnpm test:integration`); skipped otherwise. It uses its own schema, created and dropped here.
 */
import { createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { guardReadQuery } from '#src/core/database/index.ts'
import {
  createMysqlConnectionSource,
  MysqlDatabaseAdapter,
} from '#src/core/database/providers/mysql/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'
import { adapterContract, type ContractEngine } from '../../adapter-contract.ts'

const url = process.env['TICKETSMITH_TEST_MYSQL_URL']
const SCHEMA = 'ticketsmith_it'

const parsed = url === undefined ? null : new URL(url)
const server = {
  host: parsed?.hostname ?? '127.0.0.1',
  port: Number(parsed?.port || 3306),
  user: decodeURIComponent(parsed?.username ?? 'root'),
  password: decodeURIComponent(parsed?.password ?? ''),
}

const admin = async (sql: string): Promise<readonly Record<string, unknown>[]> => {
  const connection = await createConnection({ ...server, multipleStatements: true })
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${SCHEMA}; USE ${SCHEMA}`)
    const [rows] = await connection.query(sql)
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
  } finally {
    await connection.end()
  }
}

const adapter: ContractEngine['adapter'] = (options = {}) =>
  new MysqlDatabaseAdapter({
    name: 'it',
    source: createMysqlConnectionSource({
      ...server,
      ...(options.reader ? { user: 'ts_reader', password: 'reader-pw' } : {}),
      ...(options.unreachable ? { port: 1 } : {}),
      database: SCHEMA,
      ssl: false,
    }),
    logger: createLogger({ level: 'silent' }),
    timeoutMs: options.timeoutMs ?? 3_000,
  })

const mysql: ContractEngine = {
  label: 'MySQL',
  dialect: 'mysql',
  available: url !== undefined,
  reset: async () => {
    await admin(`
      DROP DATABASE IF EXISTS ${SCHEMA};
      CREATE DATABASE ${SCHEMA};
      USE ${SCHEMA};
      CREATE TABLE accounts (
        id INT PRIMARY KEY,
        name VARCHAR(100) NOT NULL COMMENT 'Customer name',
        status VARCHAR(20),
        note VARCHAR(100)
      );
      CREATE TABLE users (
        id INT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        account_id INT NOT NULL,
        settings JSON,
        KEY idx_account (account_id),
        CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts (id)
      );
      CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, account_id INT, body VARCHAR(100));
      INSERT INTO accounts VALUES
        (1, 'Northwind', 'active', NULL), (2, 'Contoso', 'active', 'it''s'), (3, 'Fabrikam', 'active', NULL);
      INSERT INTO users VALUES
        (1, 'ana@northwind.mx', 1, '{"role": "owner"}'),
        (2, 'luis@northwind.mx', 1, NULL),
        (3, 'eva@contoso.mx', 2, '{"role": "admin"}');
      DROP USER IF EXISTS 'ts_reader'@'%';
      CREATE USER 'ts_reader'@'%' IDENTIFIED BY 'reader-pw';
      GRANT SELECT ON ${SCHEMA}.* TO 'ts_reader'@'%';
    `)
  },
  drop: async () => {
    await admin(`DROP USER IF EXISTS 'ts_reader'@'%'; DROP DATABASE IF EXISTS ${SCHEMA}`)
  },
  adapter,
  admin,
  sleepSql: (seconds) => `SELECT SLEEP(${seconds}) AS s FROM users`,
  // MySQL accepts this inside a session; the protection is that each call runs exactly one
  // statement and re-enables read-only mode before it.
  switchOffSql: 'SET SESSION transaction_read_only = OFF',
}

adapterContract(mysql)

describe.skipIf(url === undefined)('MysqlDatabaseAdapter: MySQL specifics', () => {
  it('reads JSON columns', async () => {
    await mysql.reset()
    const db = adapter()
    const query = guardReadQuery(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(settings, '$.role')) AS role FROM users ORDER BY id",
      { dialect: 'mysql', maxRows: 10 },
    )
    if (!query.ok) throw new Error(query.error.reason)
    expect(await db.runReadQuery(query.value)).toMatchObject({
      ok: true,
      value: { rows: [{ role: 'owner' }, { role: null }, { role: 'admin' }] },
    })
    await db[Symbol.asyncDispose]()
    await mysql.drop()
  })
})
