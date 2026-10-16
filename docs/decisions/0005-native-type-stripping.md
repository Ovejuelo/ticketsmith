# 0005. Node type stripping + tsdown instead of tsx + tsup

- **Status:** accepted (2026-10-15)

## Context
Node 24 runs TypeScript directly; tsup is in maintenance mode.

## Decision
Run `.ts` with Node in development, typecheck with `tsc --noEmit`, bundle with tsdown. `erasableSyntaxOnly` forbids enums, namespaces and parameter properties.

## Consequences
Fewer moving parts; code must stick to erasable syntax.
