# 0004. Biome for lint/format, dependency-cruiser for architecture

- **Status:** accepted (2026-10-15)

## Context
We want few tools and enforced module boundaries.

## Decision
Biome replaces eslint + prettier; dependency-cruiser enforces layers, boundaries and cycles (with the swc parser, since TypeScript 7 has no JS API yet).

## Consequences
One formatter/linter config; architecture violations fail `pnpm check`.
