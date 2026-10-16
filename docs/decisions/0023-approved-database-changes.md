# 0023. Approved database changes: write guard, preflight and terminal approval

- **Status:** accepted (2026-10-16)

## Context
Service requests need a single INSERT or UPDATE. The first project's account can write to every database (ADR 0010), so protection has to live in Ticketsmith. Requirements §4.10 and ADR 0011 set the rule: the agent proposes, a human approves outside the LLM, and Ticketsmith executes.

## Decision
- **Opt-in per database** (`allowChanges`, default false); `db_propose_change` exists only when some database allows changes. **Max rows** per change: `changes.maxRows`, default 100.
- **Write guard** with the read guard's structure: the shared text scan, the whole tree walked, and the regenerated SQL executed. Only one INSERT … VALUES (explicit columns) or one single-table UPDATE … WHERE on a table with a primary key in the investigated catalog. The WHERE must pin rows (`column = literal` / `column IN (literals)` under AND). No DELETE, REPLACE, DDL, INSERT … SELECT, ON DUPLICATE KEY, IGNORE, ORDER BY/LIMIT, subqueries, variables or functions outside a deterministic allowlist.
- **Read-only preflight:** an UPDATE's WHERE becomes a guarded SELECT of the primary key and the changed columns. It counts the rows, captures the values for an UPDATE-per-row rollback script and is EXPLAINed. INSERT rollbacks (`DELETE … WHERE pk = …`) are written after execution from the AUTO_INCREMENT ids: they are files for a person, never run by Ticketsmith.
- **Change requests** as owner-only `local/changes/<id>.json` with real values; they expire after one hour.
- **Approval only in an interactive terminal** (`ticketsmith changes approve <id>`, no flag to skip it). It re-runs the guard and the preflight, shows the exact SQL with real values and the rollback, and requires typing the database name. Only then is an `ApprovedChange` made: the branded type `DatabaseAdapter.executeChange` requires. A test fails if any MCP tool source mentions it.
- **Execution:** a READ WRITE transaction for that one statement; COMMIT only if MySQL's affected rows equal the preflight count, otherwise ROLLBACK. The session is set back to read-only before the pooled connection is reused (verified on MySQL 8.4.9).

## Consequences
A wrong or malicious proposal can at worst be shown to a person, who must type the database name to run it, and it runs only if the data still matches what they saw. Writes the guard cannot prove narrow (OR conditions without a pinned column, range-only WHERE, tables without a primary key) are rejected; those stay manual scripts. Approvals cannot be automated, by design.
