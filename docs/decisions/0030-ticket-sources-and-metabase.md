# 0030. More ticket sources (JIRA Data Center) and Metabase as an integration

- **Status:** accepted (2026-10-17)

## Context
Teams on self-hosted JIRA could not use Ticketsmith: Data Center speaks REST API v2, uses personal access tokens and writes wiki markup instead of ADF. Report tickets end in a SQL query that someone pastes into Metabase by hand (requirements §4.6, open question 2).

## Decision
- **JIRA Data Center** is a second `TicketSource` provider (`type: jira-data-center`):
  - It uses API v2 with a personal access token sent as Bearer, offset pagination (the page token is the next `startAt`), and users identified by key.
  - The pure `wikiToMarkdown` converts descriptions and comments into the same normalized `Ticket`. Unknown markup stays as text.
  - `markdownToWiki` writes comments back for the L2 commands.
  - It reuses the Cloud HTTP client, schemas and normalization, and its base URL may carry a context path.
- **Metabase** is an optional integration (`metabase`), configured like the others:
  - The project stores its URL, the mapping from project databases to Metabase database ids, and an optional collection. The API key is a keychain entry (`metabase-api-key`, header `x-api-key`).
  - `process` writes the report playbook's `reportSql` to `out/<KEY>/report.sql`.
  - `ticketsmith metabase publish <KEY>` shows the question, its database and its guessed variables (`templateTags`). The person confirms `y/N`, and Ticketsmith then creates a native question (`POST /api/card`), audited by hash.
  - The agent never gets a Metabase tool.
  - Queries that still hold masked placeholders are refused.

## Consequences
Self-hosted JIRA and Metabase reports work without new agent capabilities. Both are verified against fakes shaped like the real APIs; Data Center still needs a live check on a real server.
