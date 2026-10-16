# 0002. JIRA Cloud first, with a read-only scoped API token

- **Status:** accepted (2026-10-15)

## Context
The company uses JIRA Cloud; OAuth may need admin approval.

## Decision
Basic auth with a scoped API token (`read:jira-work`, `read:jira-user`) through the `api.atlassian.com` gateway; classic tokens remain possible with a `doctor` warning.

## Consequences
Least privilege with little friction. The board (agile) API needs extra scopes; `jira discover` falls back to a project JQL.
