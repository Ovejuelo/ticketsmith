# 0027. Ticket writes (L2) are posted by a person from the CLI

- **Status:** accepted (2026-10-17)

## Context
L2 (requirements §4.9) allows posting a comment or a transition in JIRA with a `y/N` confirmation of the exact content. The agent could get write tools behind a confirmation, but Claude Code permission prompts do not count as approval (§2.4), and the agent already produces the comment as a file.

## Decision
- The agent never gets a write tool for the ticket source. It writes `jira_comment.md` and may suggest a transition (`analysis.md`).
- A person posts with `ticketsmith comment <KEY>` and `ticketsmith transition <KEY> [status]`, or accepts the offer at the end of `process`. These run only in an interactive terminal, with the exact text (or transition) shown and `y/N`.
- Writes are opt-in per ticket source (`allowWrites`, default false) and use the same token with `write:jira-work`; `doctor` reads the account's comment and transition permissions. A port `TicketWriter` keeps it source-agnostic; JIRA Cloud converts Markdown to ADF (`markdownToAdf`).
- Writes are one request, never retried, and audited by ticket, content hash and length.

## Consequences
Nothing reaches the ticket source without a person reading it first; automation of L2 needs a later, explicit decision. Comments carry real values (the local, revealed `jira_comment.md`), which is expected for the company's own JIRA.
