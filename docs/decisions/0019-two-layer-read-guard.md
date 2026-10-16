# 0019. Two-layer read guard that executes the regenerated SQL

- **Status:** accepted (2026-10-15)

## Context
Database accounts may be write-capable (the first project's is), so reads must be safe by construction. Probing node-sql-parser 5.4.0 showed it drops constructs MySQL executes: executable comments (`SELECT /*!50000 SLEEP(1) */ 1`), optimizer hints, and `--` without a following space (`SELECT 1 --1, SLEEP(10)` hid `SLEEP` from the parser). It also reports `SLEEP`, `@a := 1` and `@@version` as ordinary selects.

## Decision
`guardReadQuery` has two layers and fails closed: (1) a text scan that skips string literals and rejects those comment tricks with explicit messages; (2) a walk of the whole syntax tree that accepts one SELECT only and rejects INTO, locking reads, assignments, variables, nested statements and waiting/locking/file functions. The SQL sent to MySQL is **regenerated from the validated tree** (`sqlify`), never the raw text, plus a row LIMIT. Execution adds MySQL-level protection: `MAX_EXECUTION_TIME`, `START TRANSACTION READ ONLY`, always `ROLLBACK`, no multi-statements; adapters only accept the `GuardedQuery` type.

Verified against MySQL 8.0 and 8.4.9 (`tests/integration/`): `START TRANSACTION READ ONLY` alone lets DDL through (it commits implicitly and runs outside the transaction), so the session is also set to `transaction_read_only = ON`. MySQL lets a session switch that off again, so it is re-applied on every call and each call runs exactly one statement; a forged switch-off cannot reach a write.

## Consequences
What runs is exactly what was checked; anything the parser misreads is either rejected or dropped, never executed. The agent sees normalized SQL (backticks, explicit `AS`) in errors. Queries using syntax node-sql-parser cannot parse are rejected; extend tests and, if needed, the parser options rather than bypassing the guard.
