# features/

**What Ticketsmith can do.** One folder per user-facing capability, holding its CLI commands (`*.command.ts`), MCP tools (`*.tool.ts`) and the logic only it uses. Each folder's `index.ts` declares the feature, and `bootstrap/features.ts` registers it.

| Feature | Commands | MCP tools |
|---|---|---|
| `projects/` | `project init\|status\|refresh\|add\|remove\|list\|use\|show\|link\|export\|import`, `jira discover` | — |
| `doctor/` | `doctor` | — |
| `tickets/` | `list`, `show` | `jira_get_issue`, `jira_search` |
| `databases/` | `db ask` | `db_select`, `db_select_group`, `db_schema` |
| `repos/` | — | `repo_list`, `repo_files`, `repo_search`, `repo_read` |
| `mcp/` | `mcp`, `mcp setup` | — |

Rules: a feature never imports another feature (shared code goes to `core/`), and it imports core modules only through their `index.ts`. How to add one: [docs/guides/adding-a-feature.md](../../docs/guides/adding-a-feature.md).
