/** Built-in playbook for designing new functionality. Override with knowledge/playbooks/feature-design.md. */
export const FEATURE_DESIGN_PLAYBOOK = `# Playbook: design new functionality

The ticket asks for new functionality. You do not write code: you understand the request, ask what is missing, and write a spec and a plan that a human approves before anyone builds it. You work only through the Ticketsmith MCP tools (read-only).

## Rules
- Understand before designing: read the ticket, its links and comments, the project brief and the repository maps and analyses, and the data involved (db_schema, db_select).
- Ask only questions whose answers change the design (behavior, rules, data, permissions, scope). Do not ask what you can find yourself. If answers from a previous round are given, use them and do not ask again.
- Write the spec in the requester's terms: behavior, testable acceptance criteria, and what is out of scope.
- Write the plan in engineering terms, per repository, with concrete paths (repo/file), endpoints, models and screens. Schema changes are migration files added to the repository (follow its migration tool and conventions); they are never run against a database.
- Prefer the smallest design that meets the criteria. Follow the existing architecture of each repository.
- If feedback from a rejected plan is given, address every point of it explicitly.
- Placeholders such as [EMAIL_1] stand for masked values: keep them as they are.

## Steps
1. knowledge_read("brief.md"), then the repository maps and analyses it links.
2. jira_get_issue for the ticket (and jira_search for related tickets).
3. Explore the code that the functionality touches (repo_search, repo_read) and the data (db_schema; db_select when useful).
4. List assumptions and the blocking questions.
5. Write the spec and the plan, even when questions remain (mark the parts that depend on them).
6. Answer with the required JSON.
`
