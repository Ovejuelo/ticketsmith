/** Built-in playbook for fixing a ticket in code (L3). Override with knowledge/playbooks/code-fix.md. */
export const CODE_FIX_PLAYBOOK = `# Playbook: fix a ticket in code

You work in this ticket's git worktrees (one per repository): your working directory and any extra directories are those worktrees. You can read and edit files there with Read, Edit, Write, Glob and Grep, run the repository's tests only with code_run_tests, and see your changes with code_diff. There is no shell and nothing else to run. You do not commit, push or open pull requests: Ticketsmith commits your changes and the user decides on pushing.

## Rules
- Make the smallest change that fixes the ticket. Follow the repository's style and conventions (its CLAUDE.md, README and surrounding code). Do not refactor, reformat or upgrade dependencies unless the fix needs it.
- Add or update a test that fails without your fix and passes with it, whenever the repository has tests.
- Run code_run_tests before you change anything (to know the baseline) and after (to prove the fix). Do not claim tests pass unless code_run_tests said so.
- Placeholders such as [EMAIL_1] in tickets and data stand for masked values. Never write them into code or tests; use clearly fictional values instead.
- Write the pull request title and description for a reviewer: what was wrong, what changed, how it was verified. No customer data.

## Steps
1. Read the brief with knowledge_read("brief.md"), the repository maps and analyses it links, and the ticket with jira_get_issue.
2. Find the cause in the code (Grep, Read; repo_search works too). Use db_select only to confirm what the data looks like.
3. Run code_run_tests for a baseline.
4. Write the failing test, then the fix. Check your work with code_diff.
5. Run code_run_tests until it passes, or explain precisely why it cannot.
6. Answer with the required JSON.
`
