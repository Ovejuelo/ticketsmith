# Testing against real databases

Unit tests use fake drivers. Integration tests in `tests/integration/` run the database code against a real MySQL and a real PostgreSQL. Each engine's tests are **skipped** unless its variable is set (`TICKETSMITH_TEST_MYSQL_URL`, `TICKETSMITH_TEST_POSTGRES_URL`), so `pnpm check` never needs Docker.

## Setup (macOS, once)

Colima + the Docker CLI: free, light (a VM you size yourself) and fully Docker-compatible. Docker Desktop and OrbStack need paid licenses for company use.

```sh
brew install colima docker
colima start --cpu 2 --memory 2 --disk 20 --vm-type vz
pnpm mysql:up        # MySQL 8.4.9 on port 3307 (root / dev), container "ticketsmith-mysql"
pnpm postgres:up     # PostgreSQL 17.6 on port 5433 (postgres / dev), container "ticketsmith-postgres"
```

Use the same versions as the project's databases (`SELECT VERSION();`). To test another version, change the image tag in the `mysql:up` or `postgres:up` script and in CI.

## Daily use

```sh
colima start && pnpm mysql:up && pnpm postgres:up   # when you need them
pnpm test:integration                               # against both
pnpm mysql:down && pnpm postgres:down && colima stop
```

The tests create and drop their own schema (`ticketsmith_it`) and a read-only account (`ts_reader`); they never touch other schemas. CI runs them against MySQL and PostgreSQL service containers.

## The adapter contract

`tests/integration/core/database/adapter-contract.ts` is the behavior **every** `DatabaseAdapter` must show against its real engine. Each engine's test only says how to reach and seed it, then runs the same suite. A new engine is done when it passes the contract:

- Guarded reads work on real SQL (joins, CTEs, subqueries) and truncation is reported.
- Introspection: tables, columns, comments, primary and unique keys, foreign keys and indexes.
- A write-capable account is told apart from a read-only one.
- **Defense in depth:** forged writes that skip the guard (`UPDATE`, `INSERT`, `DELETE`, `CREATE`, `DROP`, `TRUNCATE`, `ALTER`) are refused by the engine itself. A forged read-only switch-off does not survive into the next call. Batches are refused. No data changes.
- Time limits and unreachable servers are reported as such.
- Approved changes commit only on the expected row count and roll back otherwise. The generated rollback script restores the rows. The keys of inserted rows are known. Pooled sessions are read-only again afterwards.

Engine specifics stay in that engine's test file (JSON functions, dollar-quoted strings, casts).
