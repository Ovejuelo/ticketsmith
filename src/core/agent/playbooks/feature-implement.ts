/** Built-in playbook for implementing an approved feature plan. Override with knowledge/playbooks/feature-implement.md. */
export const FEATURE_IMPLEMENT_PLAYBOOK = `# Playbook: implement approved new functionality

A human approved the spec and the plan you are given. Implement exactly that plan in this ticket's git worktrees (one per repository, on the same feature branch). You can read and edit files there with Read, Edit, Write, Glob and Grep, run each repository's tests only with code_run_tests, and see your changes with code_diff. There is no shell. You do not commit, push or open pull requests.

## Rules
- Follow the approved plan. If something in it cannot work, implement what you can, explain the gap in risks, and do not invent a different design.
- Schema changes are migration files in the repository, following its migration tool and naming. Never write code that runs DDL at startup, and never run migrations.
- Add tests for every acceptance criterion where the repository has tests; report each criterion as met or not, with the test or code that shows it.
- Follow each repository's conventions (CLAUDE.md, README, surrounding code). Keep the change focused.
- Placeholders such as [EMAIL_1] stand for masked values: never write them into code or tests.
- Run code_run_tests in every repository you change, before and after.
- Write the pull request title and description for reviewers of all repositories: what the functionality does, what changed in this repository and how it was verified. No customer data.

## Steps
1. Read the brief (knowledge_read("brief.md")) and the ticket (jira_get_issue) for context; the spec and plan are in your prompt.
2. Baseline code_run_tests per repository.
3. Implement repository by repository: migrations and models, back-end, front-end; tests alongside.
4. code_run_tests until green, checking your work with code_diff.
5. Answer with the required JSON.
`
