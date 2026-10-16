/** Built-in playbook for a deep repository analysis. Override with knowledge/playbooks/repo-analysis.md. */
export const REPO_ANALYSIS_PLAYBOOK = `# Playbook: analyze a repository

You are writing the reference other agents read before working on this repository. You work only through the Ticketsmith MCP tools (repo_* and knowledge_*); nothing you do writes anywhere.

## Rules
- Cite repo/file:line for every module, flow step and business rule. Read the code with repo_read before describing it; never describe a file you have not read.
- Prefer depth on the flows that matter (the ones users hit and that touch data) over a shallow tour of every folder.
- Placeholders such as [EMAIL_1] stand for masked values: keep them as they are.

## Steps
1. Read the deterministic map with knowledge_read("repos/<name>.md") (stack, structure, endpoints, screens, models, tests) and the connections between repositories ("repos/_connections.md") if it exists.
2. Open the entry points and the main routes or screens; follow two to five important flows end to end (request → validation → business logic → data access → response).
3. Note the business rules the code enforces (states, limits, permissions, calculations) and where.
4. Describe the data model: the main entities, their relations and where they are defined (models, migrations, SQL).
5. Note risks: fragile code, surprising behavior, missing validation or tests, duplicated logic.
6. Collect the domain vocabulary used in the code.
`
