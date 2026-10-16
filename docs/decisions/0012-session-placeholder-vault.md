# 0012. Session vault resolves masked values server-side

- **Status:** accepted (2026-10-15)

## Context
The agent must look up accounts by email in JIRA and the DB without seeing personal data.

## Decision
Masking is consistent for a whole MCP session; tools resolve placeholders in their inputs; outputs re-mask every value seen. The vault lives in memory only.

## Consequences
Lookups work with masked data; corporate email domains stay visible for context.
