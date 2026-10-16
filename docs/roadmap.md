# Ticketsmith — Roadmap

| Phase | Deliverable | Value when done |
|---|---|---|
| **0. Foundations** ✅ | Repo, strict TS, Biome, dependency-cruiser, vitest, tsdown, CI, kernel (Result, errors, logger), base CLI | `ticketsmith --version` and `pnpm check` green |
| **1. JIRA** ✅ | Config + profiles + keychain, `init`, `doctor`, `JiraCloudTicketSource`, `adfToMarkdown`, `discover`, `list`, `show` | **Usable on day one:** `ticketsmith show PROJ-123 \| claude` |
| **2. MCP** ✅ | `ticketsmith mcp` with `jira_get_issue` and `jira_search`, masking, session vault, audit | Use your tickets from Claude Code |
| **3. Projects and onboarding** ✅ | Profile → project with **optional, independent integrations**; `project init` resumable wizard; storage (`project.yaml` + `knowledge/` shareable, `local/project.sqlite` via `node:sqlite`); ticket-source step with JIRA investigation (issue types, workflows, fields); `project status/refresh/add/remove/use/link/export/import`; automatic migration of existing profiles; commands and MCP tools enabled per configured integration | One command sets up a project; knowledge persists and can be shared through a separate repo |
| **4. DB reads** | Databases onboarding step (any number of named databases, optional groups sharing a schema; schema investigated into SQLite and knowledge), read guard (adversarial tests first), `MysqlDatabaseAdapter`, MCP `db_select`/`db_schema` and group lookups with masking and vault, `db ask`, DB `doctor` | Claude finds accounts and investigates data |
| **Distribution** ✅ | Public repo (MIT, fresh history, private-terms guard), npm package with update notice, Claude Code plugin + marketplace (`npx ticketsmith@latest mcp`, `investigate-ticket` skill), `pnpm release` + tag-triggered publish workflow | Anyone installs it with npm + two plugin commands and gets updates automatically |
| **5. Repos** (live check pending) | Repositories onboarding step (any number of repos on any host): dedicated clones, runtime per repo, deterministic project maps and cross-repo connections in knowledge, MCP `repo_list`/`repo_files`/`repo_search`/`repo_read`, repo `doctor` checks | Claude understands back and front before touching them |
| **6. Agent + bugs** (live check pending) | `ClaudeCodeCliRuntime` (MCP tools only, local HTTP tool server, revealed outputs), `process <KEY>`/`--next`, `bug` and `repo-analysis` playbooks, `knowledge_read`/`knowledge_search`, `project refresh repos --deep`, agent `doctor` check | First end-to-end analysis |
| **7. Approved DB writes** (live check pending) | Write guard, `db_propose_change`, `changes show/approve/reject`, preflight, rollback scripts | Service requests resolved with one approval |
| **8. Code changes (L3)** (live check pending) | `ticketsmith code <KEY>`: worktree and branch per ticket from the fix branch, file tools confined to it (no shell), `code_run_tests`/`code_diff`, tests re-run by Ticketsmith, ask-before-push, PRs through GitHub or Bitbucket Cloud APIs or a link for any other host | Bugs fixed with human review |
| **9. New functionality** (live check pending) | Feature playbook: spec + clarifying questions → design plan the human approves → coordinated back/front worktrees from the feature base branch → new tests → schema changes as migration files → ask before PRs (requirements §4.15) | New functionality tickets implemented end to end with two human checkpoints |
| **10. Classification + knowledge + evals** | Rules + LLM, `classify`, `knowledge add`, golden set, `eval` | Measure before raising autonomy |
| **11. Reports, service requests, L2 JIRA** | Playbooks, `jira_add_comment`/`jira_transition` with confirmation | |
| **12. Extension** | `AgentSdkRuntime`, JIRA Data Center, OAuth, other DB engines + contract suites, Metabase API | |

Each later phase also adds its own onboarding step (databases in 4, repositories in 5).

One phase at a time, each planned and approved before coding (see `CLAUDE.md`). A phase is done when `pnpm check` is green and it was verified against the real systems.
