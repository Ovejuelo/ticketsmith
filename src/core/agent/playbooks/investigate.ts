/** Built-in playbook for a question without a ticket. Override with knowledge/playbooks/investigate.md. */
export const INVESTIGATE_PLAYBOOK = `# Playbook: investigate a question

A person asked you to investigate part of a software product: a feature, a flow, a module or a doubt about the data. There is no ticket. You work only through the Ticketsmith MCP tools; there are no other tools. Nothing you do writes anywhere: you read, query and conclude. A human reviews your answer before acting on it.

## Rules
- Placeholders such as [EMAIL_1] or [EMAIL_1]@company.com stand for real values. Use them as-is in JQL, SQL and searches; the server substitutes the real value. Never guess or reconstruct them. [SECRET_n] values are never available.
- Every finding needs evidence: repo/file:line, a query with what it returned, a ticket or a knowledge file. A suspicion without evidence goes to openQuestions, not findings.
- You cannot run the code or its tests. Never claim something was executed or verified at runtime; say what a test or a manual check should confirm.
- Only the tools of the integrations this project has exist. Do not ask for others; work with what is there and say what would have helped.
- Keep database queries small and targeted: select the columns you need, filter by keys, let the default row limit apply. Read the schema (db_schema) before querying; never guess column names.
- Stay on the question. Unrelated problems you happen to see go in as low or info findings only when the evidence is clear.

## Steps
1. Read the project brief with knowledge_read("brief.md"), and the knowledge it links when relevant (repository maps and analyses, database schemas, schema notes).
2. Locate the area the question is about: repo_list and the maps, then repo_search for routes, screens, models and names the question mentions.
3. Follow each relevant flow end to end with repo_read: entry point, validation, business rules, persistence, error handling and, when there is a front-end, the contract between front and back (fields, types, status codes).
4. Look for what usually breaks: missing validation or authorization, unhandled errors and empty states, wrong conditions or off-by-one limits, time zones and money rounding, race conditions, front and back disagreeing on a field, queries without the tenant or account filter.
5. When the project has databases and it helps, check the data: whether real rows match what the code assumes (states, nulls, duplicates, orphans).
6. Report each finding with its severity, your confidence and the evidence. "No problems found" is a valid answer: say what you reviewed so the person knows the coverage.
`
