# core/

**Reusable building blocks shared by features.** Core knows nothing about specific features, the CLI program or the MCP server. Each module exposes its public API through `index.ts`.

| Module | Holds |
|---|---|
| `kernel/` | `Result`, `AppError`, logger. Depends on nothing |
| `agent/` | `AgentRuntime` port with `providers/claude-code` (headless, MCP tools only), built-in playbooks, output schemas, `runStructured` (validate + one retry) |
| `project/` | `Project` model with optional integrations, `project.yaml` store, paths, migration of phase-1 profiles |
| `secrets/` | `SecretStore` port with `providers/keyring` and `providers/env` |
| `storage/` | Per-project SQLite (`node:sqlite`): onboarding steps and the investigated catalog |
| `knowledge/` | Masked Markdown writer and the project brief |
| `tickets/` | `Ticket` model, `TicketSource` port, ADF→Markdown, JIRA Cloud (`providers/jira-cloud`) |
| `database/` | Fail-closed read and write guards, read-only preflight with rollback scripts, change requests (`ChangeStore`), `DatabaseAdapter` port (`executeChange` only takes an `ApprovedChange`), schema catalog types, `providers/mysql` |
| `repos/` | Git without a shell (clone, fetch, and reads from git objects only), dedicated clones, ticket worktrees and branch rules, `PullRequestHost` port with `providers/github` and `providers/bitbucket-cloud` |
| `security/` | Masking and the session placeholder vault |
| `audit/` | `AuditLog` port and its JSONL implementation |
| `output/` | Per-ticket output files |
| `services/` | `Services`: what features get from the outside world (built in `bootstrap/composition-root.ts`); `DatabaseConnections` |
| `cli/` | Command contracts (`CommandDeps`), IO, prompts, option parsing, `openProject`, `requireTickets` |
| `mcp/` | Tool contract (`defineTool`, `ToolContext`) |
| `feature/` | The `Feature` type |

Only `bootstrap/composition-root.ts` may import `providers/`. How to add one: [docs/guides/adding-a-provider.md](../../docs/guides/adding-a-provider.md).
