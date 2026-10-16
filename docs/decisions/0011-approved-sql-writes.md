# 0011. The agent proposes SQL writes, a human approves them in the terminal

- **Status:** accepted (2026-10-15)

## Context
Service requests need `INSERT`/`UPDATE`; the user wants to only confirm.

## Decision
Change requests: a single `INSERT … VALUES` or `UPDATE … WHERE`, a read-only preflight with a rollback script, and approval through `ticketsmith changes approve` (requirements §4.10).

## Consequences
The model can never execute or approve a write by itself.
