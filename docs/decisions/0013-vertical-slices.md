# 0013. Organize by feature (vertical slices) over a shared core

- **Status:** accepted (2026-10-15)

## Context
The product grows by capabilities, each with CLI commands, MCP tools and logic; a layer-first layout scattered each one across folders.

## Decision
`src/features/<capability>/` holds everything a capability needs; `src/core/` holds what features share; `src/bootstrap/` wires them. Features never import each other. Role suffixes (`.command.ts`, `.tool.ts`, `.port.ts`, `.schema.ts`) identify files at a glance.

## Consequences
`ls src/features` describes the product; adding or removing a capability touches one folder plus one line in `bootstrap/features.ts`.
