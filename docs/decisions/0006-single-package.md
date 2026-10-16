# 0006. Single package, not a monorepo

- **Status:** accepted (2026-10-15)

## Context
One CLI, one team.

## Decision
Keep one package; migrate to pnpm workspaces only if a part must be published separately.

## Consequences
Boundaries are already enforced, so a later split is mechanical.
