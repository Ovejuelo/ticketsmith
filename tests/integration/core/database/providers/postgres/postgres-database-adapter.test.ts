/**
 * Runs against a real PostgreSQL when TICKETSMITH_TEST_POSTGRES_URL is set (see `pnpm postgres:up`
 * and `pnpm test:integration`); skipped otherwise. It uses its own schema, created and dropped here.
 */
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { guardReadQuery } from '#src/core/database/index.ts'
import {
  createPostgresConnectionSource,
  PostgresDatabaseAdapter,
} from '#src/core/database/providers/postgres/index.ts'
import { createLogger } from '#src/core/kernel/index.ts'
import { adapterContract, type ContractEngine } from '../../adapter-contract.ts'

const url = process.env['TICKETSMITH_TEST_POSTGRES_URL']
const SCHEMA = 'ticketsmith_it'

const parsed = url === undefined ? null : new URL(url)
const server = {
  host: parsed?.hostname ?? '127.0.0.1',
  port: Number(parsed?.port || 5432),
  user: decodeURIComponent(parsed?.username ?? 'postgres'),
  password: decodeURIComponent(parsed?.password ?? ''),
  database: parsed?.pathname.slice(1) || 'postgres',
}

const admin = async (sql: string): Promise<readonly Record<string, unknown>[]> => {
  const client = new pg.Client(server)
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}; SET search_path TO ${SCHEMA}`)
    const result = await client.query(sql)
    const last = Array.isArray(result) ? result.at(-1) : result
    return last?.rows ?? []
  } finally {
    await client.end()
  }
}

const adapter: ContractEngine['adapter'] = (options = {}) =>
  new PostgresDatabaseAdapter({
    name: 'it',
    schema: SCHEMA,
    source: createPostgresConnectionSource({
      ...server,
      ...(options.reader ? { user: 'ts_reader', password: 'reader-pw' } : {}),
      ...(options.unreachable ? { port: 1 } : {}),
      ssl: false,
    }),
    logger: createLogger({ level: 'silent' }),
    timeoutMs: options.timeoutMs ?? 3_000,
  })

const dropReader = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ts_reader') THEN
    DROP OWNED BY ts_reader; DROP ROLE ts_reader;
  END IF;
END $$`

const postgres: ContractEngine = {
  label: 'PostgreSQL',
  dialect: 'postgres',
  available: url !== undefined,
  reset: async () => {
    await admin(`
      ${dropReader};
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE accounts (
        id INT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(20),
        note VARCHAR(100)
      );
      COMMENT ON COLUMN accounts.name IS 'Customer name';
      CREATE TABLE users (
        id INT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        account_id INT NOT NULL REFERENCES accounts (id),
        settings JSONB
      );
      CREATE INDEX idx_account ON users (account_id);
      CREATE TABLE notes (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id INT, body VARCHAR(100));
      INSERT INTO accounts VALUES
        (1, 'Northwind', 'active', NULL), (2, 'Contoso', 'active', 'it''s'), (3, 'Fabrikam', 'active', NULL);
      INSERT INTO users VALUES
        (1, 'ana@northwind.mx', 1, '{"role": "owner"}'),
        (2, 'luis@northwind.mx', 1, NULL),
        (3, 'eva@contoso.mx', 2, '{"role": "admin"}');
      CREATE ROLE ts_reader LOGIN PASSWORD 'reader-pw';
      GRANT USAGE ON SCHEMA ${SCHEMA} TO ts_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ts_reader;
    `)
  },
  drop: async () => {
    await admin(`${dropReader}; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  },
  adapter,
  admin,
  sleepSql: (seconds) => `SELECT pg_sleep(${seconds})`,
  // SET is transactional in PostgreSQL: the ROLLBACK that ends every read undoes it.
  switchOffSql: 'SET SESSION default_transaction_read_only = off',
}

adapterContract(postgres)

describe.skipIf(url === undefined)('PostgresDatabaseAdapter: PostgreSQL specifics', () => {
  it('reads JSONB, casts and dollar-quoted strings; dates stay as text', async () => {
    await postgres.reset()
    const db = adapter()
    const query = guardReadQuery(
      "SELECT settings->>'role' AS role, id::text AS key, $$it's$$ AS s, DATE '2026-10-16' AS d FROM Users ORDER BY id",
      { dialect: 'postgres', maxRows: 10 },
    )
    if (!query.ok) throw new Error(query.error.reason)
    expect(await db.runReadQuery(query.value)).toMatchObject({
      ok: true,
      value: {
        rows: [
          { role: 'owner', key: '1', s: "it's", d: '2026-10-16' },
          { role: null, key: '2' },
          { role: 'admin', key: '3' },
        ],
      },
    })
    await db[Symbol.asyncDispose]()
    await postgres.drop()
  })
})
