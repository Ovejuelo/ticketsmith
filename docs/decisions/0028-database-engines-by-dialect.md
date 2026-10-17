# 0028. Database engines by dialect, proven by one adapter contract

- **Status:** accepted (2026-10-17)

## Context
Projects may use databases other than MySQL; PostgreSQL is the most common next one. The protection of reads and writes (ADR 0019, ADR 0023) must not weaken for a new engine. Each engine also differs in syntax the guard has to understand: comments, string literals, functions with side effects, and how names are quoted.

## Decision
- The read and write guards take a `dialect` (`mysql` | `postgres`) from the database's configured `type`. node-sql-parser parses with that dialect's grammar, and what runs is still the SQL regenerated from the validated tree (`core/database/sql-dialect.ts`).
- Each dialect has its own text layer and function denylist. For PostgreSQL:
  - dollar-quoted strings are skipped;
  - nested comments and backslashes in string literals are rejected, because the server and the parser could disagree on where code is;
  - `$1` parameters are rejected;
  - functions that wait, read files, take locks, touch sequences or run SQL passed as text (`query_to_xml`, `ts_stat`, `dblink*`…) are denied.
- node-sql-parser quotes every table name it regenerates for PostgreSQL. `foldPostgresNames` lowercases the names written without quotes, so `FROM Users` keeps meaning `users`.
- `PostgresDatabaseAdapter`:
  - **Sessions** default to read-only (`default_transaction_read_only`).
  - **Reads** run in `BEGIN READ ONLY`, with `statement_timeout` and the configured `search_path`, and always end in `ROLLBACK`.
  - **Statements** go one per call through the extended protocol, which refuses batches.
  - **Approved changes** use an explicit `BEGIN READ WRITE`, commit only on the expected row count, and return the inserted keys (`RETURNING`) for the rollback script.
- One integration suite, `tests/integration/core/database/adapter-contract.ts`, states what every adapter must do against its real engine. MySQL and PostgreSQL both run it locally (Docker) and in CI. A new engine is done when it passes the contract.

## Consequences
Adding an engine is a provider, a dialect entry in the guards with its own adversarial tests, and a seeded contract run. Some valid PostgreSQL is refused: strings with backslashes and `$tag$` strings that contain `$`. The guard fails closed rather than guess.
