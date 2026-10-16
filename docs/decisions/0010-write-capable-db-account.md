# 0010. Support write-capable DB accounts, protected by Ticketsmith

- **Status:** accepted (2026-10-15)

## Context
The first project has no read-only DB user for its databases, and other projects may be in the same situation.

## Decision
The agent never gets credentials or a raw connection. Reads go through a fail-closed guard inside `READ ONLY` transactions that always roll back.

## Consequences
All DB protection lives in code and needs adversarial tests; a read-only account per database remains preferable.
