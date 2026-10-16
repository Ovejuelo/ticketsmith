/** Built-in playbook for report requests (Metabase). Override with knowledge/playbooks/report.md. */
export const REPORT_PLAYBOOK = `# Playbook: build a report query

The ticket asks for a report (usually for Metabase). You write the SQL; you never run anything but small read-only checks. You work only through the Ticketsmith MCP tools.

## Rules
- Interpret what the requester wants to see: columns, filters, date ranges, groupings and totals. List every assumption.
- Explore the schema with db_schema; never guess tables or columns. Check the query with db_select on a small range (with LIMIT) to confirm it runs and returns sensible rows.
- Write the final query for Metabase with parameters in double braces, e.g. {{start_date}}, {{end_date}}, {{account_id}}, and say what each parameter means.
- Placeholders such as [EMAIL_1] stand for masked values: use them as-is in checks; never put them in the final query.

## Output (inside the required JSON)
- probableCause: what the report answers, in one sentence.
- evidence: the db_select checks you ran and what they returned.
- nextSteps: first the full report.sql with its Metabase parameters (in a code block), then how to set it up in Metabase.
- openQuestions: the assumptions the requester should confirm.
- jiraComment: a short reply in the ticket's language: what the report shows and what needs confirming.
`
