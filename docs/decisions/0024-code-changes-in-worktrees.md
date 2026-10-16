# 0024. Code changes in ticket worktrees: confined file tools, no shell, pushes on approval

- **Status:** accepted (2026-10-16)

## Context
L3 (requirements §4.9) lets the agent fix a bug in code and prepare the pull request. It must never touch the user's working copies or protected branches, never push without a person agreeing, and must work for any git host (Ticketsmith is public; the first project happens to use Bitbucket).

## Decision
- **Opt-in per repository** (`allowCodeChanges`). `ticketsmith code <KEY>` creates one git worktree per repository under `local/worktrees/<KEY>/<repo>`, on a branch named by `branchPattern` from the fix branch. The name comes from the pattern, never from the agent. A second run reuses the worktree.
- **Tools:** Claude Code's Read, Edit, Write, Glob and Grep, which `--restricted` confines to the worktrees (verified on Claude Code 2.1.301: reads and writes outside are denied). **No shell.** The configured `testCommand` runs only through the MCP tool `code_run_tests`, with the repo's Node version via fnm, credentials removed from the environment and a timeout; `code_diff` shows the changes. The worktree holds tracked files only, so no `.env`; code is read unmasked, as §2.7 allows. The repository's own CLAUDE.md is loaded as its conventions.
- **Verification by Ticketsmith:** it commits the changes with the user's git identity, re-runs the tests itself and writes `out/<KEY>/code/` (summary, one diff per repository, run.json).
- **Push only on an interactive yes**, with an explicit refspec, never `--force`, and never to protected, base or PR-target branches (`checkPushable`).
- **Pull requests per host:** a `PullRequestHost` port with GitHub (Enterprise through `host.apiUrl`) and Bitbucket Cloud providers. Each makes one POST, never retried, with a token stored in the keychain as `git-host-<host>` on first use. Any other host, or a missing token, gets the host's link (when known) and the text to paste. The PR text is the agent's masked text, because it leaves the machine; the local summary is revealed.

## Consequences
The agent can change only the ticket's worktrees and run only the command the user configured. A person reads the diff and decides each push. New hosts (GitLab, Bitbucket Data Center) are new providers behind the same port. Tests that need dependencies installed in the worktree only pass if the configured command installs them (e.g. `npm ci && npm test`).
