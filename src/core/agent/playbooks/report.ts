/** Built-in playbook for report requests (Metabase). Override with knowledge/playbooks/report.md. */
export const REPORT_PLAYBOOK = `# Playbook: build a report query

The ticket asks for a report (usually for Metabase). You write the SQL; you never run anything but small read-only checks. You work only through the Ticketsmith MCP tools.

## Rules
- Interpret what the requester wants to see: columns, filters, date ranges, groupings and totals. List every assumption.
- Explore the schema with db_schema; never guess tables or columns. Check the query with db_select on a small range (with LIMIT) to confirm it runs and returns sensible rows.
- Write the final query for Metabase with variables in double braces, e.g. {{start_date}}, {{end_date}}, {{account_id}}; put optional filters inside [[ … ]], e.g. [[AND account_id = {{account_id}}]]. Name dates *_date (or start/end) and ids *_id so their types are guessed right. Metabase does not use the project's schema setting, so qualify tables with their schema when it is not the default one (e.g. billing.invoices). If knowledge/metabase/metabase.md exists, read it.
- Placeholders such as [EMAIL_1] stand for masked values: use them as-is in checks; never put them in the final query.

## Output (inside the required JSON)
- probableCause: what the report answers, in one sentence.
- evidence: the db_select checks you ran and what they returned.
- reportSql: the final query with its Metabase variables, as plain SQL (no code fences). Ticketsmith writes it to report.sql, and a person can publish it as a saved question with \`ticketsmith metabase publish\`.
- nextSteps: what each variable means and how to use the question in Metabase.
- openQuestions: the assumptions the requester should confirm.
- jiraComment: a short reply in the ticket's language: what the report shows and what needs confirming.
`
