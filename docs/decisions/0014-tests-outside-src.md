# 0014. Tests outside src, mirroring it

- **Status:** accepted (2026-10-15)

## Context
Tests mixed with sources were hard to tell apart.

## Decision
`tests/unit/` mirrors `src/`; fakes in `tests/support/`, fixtures in `tests/fixtures/`; Node subpath aliases `#src/…` and `#tests/…`.

## Consequences
`src/` is production code only, enforced by `pnpm arch`.
