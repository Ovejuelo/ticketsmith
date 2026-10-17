---
name: investigate-ticket
description: Investigate a ticket with the Ticketsmith tools (read the ticket, look the data up in the project databases, read the code of the project repositories) and report findings with evidence. Use when the user names a ticket key such as OPS-123, or asks what is going on with a ticket, an account or a customer.
---

# Investigate a ticket

You work through the `ticketsmith` MCP tools. They already mask sensitive values and keep every database read guarded; you never get credentials and never need them.

## Rules

- **You never write.** If a fix needs a data change and `db_propose_change` is available, propose exactly one INSERT/UPDATE with the row count you measured: it does not run, the user approves it with `ticketsmith changes approve <id>` in their own terminal. Never claim a change was made. Without that tool, describe the change and stop: a human applies it.
- **Placeholders are values.** Emails, phones, tax ids and cards arrive as placeholders like `[EMAIL_1]` or `[EMAIL_1]@company.com`. Use them as-is in JQL and SQL (`WHERE email = '[EMAIL_1]@company.com'`); the server substitutes the real value. Never try to guess or recover them.
- **Evidence over guesses.** Every claim cites its source: the ticket field or comment, the query and its rows, or `file:line`. Say "unknown" instead of inventing.
- Only the tools the project has configured exist. If a tool you need is missing, say which integration to add (`ticketsmith project add <integration>`).

## Steps

1. **Read the ticket** with `jira_get_issue`. Extract the symptom, steps, dates, identifiers (accounts, emails, folios, ids) and which database or environment it names. Check linked or similar tickets with `jira_search` when useful.
2. **Read the project knowledge** (and look for similar resolved cases with `knowledge_search`, they live in knowledge/cases/) with `knowledge_read("brief.md")`: it links the repository maps and analyses, the database schemas and the project's playbooks. Use `knowledge_search` to find a table, endpoint or domain term across all of it.
3. **Find the data.**
   - Start with `db_schema` to see the tables of a database or group, then one table's columns, keys and referrers. Do not guess column names.
   - If the ticket names the database, query it with `db_select`. If not and the databases form a group, find the right one with `db_select_group` using a narrow lookup (an id or email).
   - Keep queries small: select the columns you need, filter by keys, let the default row limit apply.
4. **Check the code** when the cause may be there and the project has repositories:
   - Start from the maps: `repo_list` says which repositories exist and where their map is (`knowledge/repos/<name>.md`: stack, endpoints, screens, models, tests); `knowledge/repos/_connections.md` links front-end calls to back-end routes.
   - Find the code with `repo_search` (a fixed string by default; `regex: true` for patterns), narrowing with `repo` and `path`. Read around each hit with `repo_read` and `startLine`/`endLine`.
   - The clones follow each repository's fix branch (production code). Pass `ref` (e.g. `develop`) to compare another branch.
   - Cite `repo/file:line` for every claim about the code.
   - You do not edit code from here. If the fix is in code, say so and suggest `ticketsmith code <KEY>`: it works in a worktree per ticket, runs the tests and asks the user before pushing.
   - If the ticket asks for new functionality rather than a fix, suggest `ticketsmith feature <KEY>`: it asks the open questions, writes a spec and a plan for the user to approve, and only then builds it.
5. **Report** in the user's language:
   - **Summary:** what the ticket asks and what you found, in two or three sentences.
   - **Evidence:** the queries you ran (with what they returned) and the code you read (`repo/file:line`).
   - **Probable cause** and your confidence (high, medium, low), with what would raise it.
   - **Next step:** the change or answer to give, including any write a human should apply (exact SQL, never run).
   - **Draft reply** for the ticket, ready to paste, without placeholders the reader would not understand.
