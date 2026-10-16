# Ticketsmith

Ticketsmith lets Claude work on your tickets. It reads tickets from JIRA Cloud and data from your databases through a local MCP server and CLI, so Claude can investigate a ticket and prepare the work for you: analysis, queries and replies.

It is **safe by construction**. Claude never gets credentials or a raw connection. Every database read goes through a guard that fails closed and runs in a read-only session. Sensitive values are masked before they reach the model. Anything that writes always needs a human's approval, outside the model.

> **Status:** v0.9. Tickets (JIRA Cloud), database reads (MySQL 8), code reading across your repositories, end-to-end ticket investigation (`ticketsmith process`), human-approved database changes, code fixes with tests and pull requests (`ticketsmith code`) and new functionality with a design checkpoint (`ticketsmith feature`) work today. Classification, cases and evals are next; see the [roadmap](docs/roadmap.md).

## Install

You need Node 24+ and [Claude Code](https://claude.com/claude-code).

```sh
npm install -g ticketsmith
ticketsmith project init                 # set up a project: ticket source, databases…
```

Then add the Claude Code plugin. It brings the MCP server (always the latest npm release, through `npx`) and the ticket-investigation skill:

```sh
claude plugin marketplace add Ovejuelo/ticketsmith
claude plugin install ticketsmith@ticketsmith
```

or, inside Claude Code: `/plugin install ticketsmith --marketplace Ovejuelo/ticketsmith`.

Ask Claude things like "investigate OPS-123" or "which database holds the account of the customer in OPS-123?".

**Updates:**
- The plugin's MCP server runs `ticketsmith@latest`, so each new Claude Code session picks up the latest release.
- Update the CLI with `npm i -g ticketsmith`; it tells you, at most once a day, when a new version is out.
- Skills update with `claude plugin update ticketsmith@ticketsmith`.

Step by step on a new machine: [docs/guides/getting-started.md](docs/guides/getting-started.md).

## How it keeps you safe

| Concern | What Ticketsmith does |
|---|---|
| Credentials | Kept in the system keychain and read only by the Ticketsmith process. The model never sees them. |
| JIRA | A scoped, read-only API token. |
| Database reads | Exactly one `SELECT`, parsed (never regex) and checked by a two-layer guard that rejects comment tricks and inspects the whole tree. Only the SQL regenerated from the validated tree runs, in a read-only session and transaction, with a time limit and a row limit, and it is always rolled back. This holds even for a write-capable account. |
| Sensitive data | Emails, phones, tax ids, bank accounts, cards and secrets become placeholders such as `[EMAIL_1]@northwind.mx` inside the tools. Claude can pass them back in JQL or SQL and the server substitutes the real value, so the model never sees it. |
| Writes | Code changes only in repositories you mark `allowCodeChanges`, in a worktree per ticket, pushed only after you say yes (never to protected branches). Database changes only on databases you mark `allowChanges`: the agent **proposes** one INSERT/UPDATE (no DELETE or DDL, ever), Ticketsmith validates it, counts the rows and prepares a rollback, and **you approve it in your terminal** by typing the database name. Later phases add JIRA comments and pull requests the same way. |
| Audit | Every MCP call is logged locally, without its content. |

Details: [requirements](docs/requirements.md) §2 and [ADR 0019](docs/decisions/0019-two-layer-read-guard.md).

## Usage

Everything happens inside a **project**, one per product you support (e.g. `billing`). A project holds its integrations, its masking rules and its investigated knowledge. Every integration is optional: a ticket source, any number of databases (grouped when they share a schema) and any number of git repositories.

```sh
ticketsmith project init              # guided, resumable onboarding: configure, verify and investigate
ticketsmith project status            # what is configured, investigated or pending
ticketsmith project refresh           # investigate again and rebuild knowledge/brief.md
ticketsmith project add|remove tickets|databases|repos
ticketsmith doctor                    # check every configured integration
ticketsmith jira discover             # pick the JIRA project/board and save the JQL
ticketsmith list --limit 20           # prioritized open tickets
ticketsmith show OPS-123              # ticket as Markdown (--json, --out, --mask)
ticketsmith db ask "SELECT id, email FROM users WHERE id = 1" --db shard1
ticketsmith db ask "SELECT id FROM accounts WHERE email = 'x@acme.com'" --group shards
ticketsmith process OPS-123           # the agent investigates: out/OPS-123/analysis.md + jira_comment.md
ticketsmith process --next            # the next ticket of the JQL without an analysis
ticketsmith project refresh repos --deep  # the agent writes knowledge/repos/<name>.analysis.md
ticketsmith mcp                       # the MCP server (the plugin runs it for you)
```

Global options: `--project <name>` (or `TICKETSMITH_PROJECT`), `--json`, `--verbose`.

### MCP tools

| Tool | Needs | What it does |
|---|---|---|
| `jira_get_issue`, `jira_search` | ticket source | A normalized ticket as Markdown; JQL search |
| `db_schema` | databases | Tables of a database or group, or one table's columns, keys and referrers (from the investigated catalog) |
| `db_select` | databases | One guarded `SELECT` on one database |
| `db_select_group` | databases | The same `SELECT` on every database of a group, e.g. to find which one holds an account |
| `db_propose_change` | databases with `allowChanges` | Propose one INSERT/UPDATE for you to approve; it never runs by itself |
| `repo_list` | repos | Repositories, base branches, the commit each clone is at, runtime, test command and map |
| `repo_files`, `repo_search`, `repo_read` | repos | List tracked files, search code across repositories (`git grep`), read a file with line numbers, at any branch |
| `knowledge_read`, `knowledge_search` | — | The project brief, repository maps and analyses, database schemas and playbooks |

Tools only appear when the project has the integration they need. Without the plugin, `ticketsmith mcp setup` prints the `claude mcp add` command to register the server yourself.

### Investigating a ticket end to end

`ticketsmith process <KEY>` runs Claude Code headless (your own Claude Code login) with the `bug` playbook and **only Ticketsmith's tools**: no shell, no file access, nothing that writes. Everything the agent reads is masked; when it finishes, the real values are put back in your local copy of its answer (secrets stay masked). It writes `out/<KEY>/analysis.md` (probable cause, evidence with `repo/file:line` and queries, confidence, next steps) and `jira_comment.md`, which you review and paste yourself. Limits live in `project.yaml` (`agent.maxBudgetUsd`, default $3; `agent.timeoutMinutes`, default 20); `--budget` and `--model` override them. Add your own playbooks as `knowledge/playbooks/<name>.md` and use them with `--playbook <name>`.

### JIRA token

Create an **API token with scopes** at https://id.atlassian.com/manage-profile/security/api-tokens with the read-only scopes `read:jira-work` and `read:jira-user`. Add `read:board-scope:jira-software` and `read:project:jira` if you want to read boards. Classic tokens also work but inherit all your permissions; `doctor` warns about them. `TICKETSMITH_JIRA_TOKEN` overrides the keychain for scripts.

### Databases

`project add databases` asks for each database's host, port, database name and user, and stores the password in the keychain (`TICKETSMITH_DB_<NAME>` for scripts). Databases that share a schema form a group: the schema is investigated once, and `db_select_group` can search all of them. VPNs and tunnels are up to you; `doctor` tells you which database is unreachable.

### Fixing code

Mark a repository with `allowCodeChanges: true` (or answer yes in `project add repos`) and run:

```sh
ticketsmith code OPS-123          # worktree + branch from the fix branch, the agent fixes and tests
ticketsmith code push OPS-123     # asks per repository, pushes (never forced) and opens the PR
ticketsmith code status           # worktrees, branches, tests, pull requests
ticketsmith code discard OPS-123  # removes the worktrees and local branches
```

The agent edits only inside the ticket's worktrees and has no shell: it runs your configured `testCommand` through Ticketsmith, which runs the tests again itself before showing you the diff. Branches follow `branchPattern` (default `fix/{key}-{slug}`, e.g. `hotfix/{key}-{slug}`). Pull requests open through GitHub (or GitHub Enterprise with `host.apiUrl`) and Bitbucket Cloud with an API token stored in the keychain on first use; for any other host you get the link and the description to paste.

### New functionality

New functionality gets a design checkpoint before any code is written:

```sh
ticketsmith feature OPS-123              # understand + spec + plan; questions go to out/OPS-123/feature/questions.md
ticketsmith feature OPS-123              # after you answer them under "Answer:", it redesigns with the answers
ticketsmith feature approve OPS-123      # interactive: only an approved plan can be built
ticketsmith feature reject OPS-123 --feedback "also 20+ units: 10% off"
ticketsmith feature implement OPS-123    # worktrees from the feature branch, tests, criteria met or not
ticketsmith feature push OPS-123         # asks per repository; PRs name the ticket and link each other
```

Schema changes come as migration files in the repository for review; Ticketsmith never runs DDL against your databases.

### Approved database changes

Mark a database with `allowChanges: true` (or answer yes in `project add databases`) and the agent can propose one `INSERT … VALUES` or `UPDATE … WHERE` per change, typically with `ticketsmith process OPS-123 --playbook service-request`. Nothing runs until you decide:

```sh
ticketsmith changes list                 # proposals, newest first
ticketsmith changes show cr-1a2b3c4d     # exact SQL with real values, affected rows, current values, rollback
ticketsmith changes approve cr-1a2b3c4d  # interactive: re-checks, then you type the database name
ticketsmith changes reject cr-1a2b3c4d --reason "not needed"
```

Approval re-runs the checks (the data may have moved), runs the statement in a transaction and commits only if MySQL affects exactly the rows you saw; otherwise it rolls back. The SQL, the rollback script and the result are saved to `out/<KEY>/change-<id>/`. Proposals expire after an hour; `changes.maxRows` (default 100) caps each change.

### Repositories

`project add repos` asks for the clone URL (ssh or https), the base branches for fixes and features and the protected branches, clones the repository into the project's `local/repos/` and detects its Node version and test command. Git access is your own: an SSH key or a credential helper; Ticketsmith never stores git credentials. Each repository gets a map in `knowledge/repos/<name>.md` (endpoints, screens, models, tests…) and `project refresh repos` fetches and re-maps what moved. The MCP tools read only tracked code, never ignored files like `.env`.

### Sharing a project with the team

A project folder is git-ready: `project.yaml` and `knowledge/` are shared, while `local/` (SQLite catalog, outputs, audit) is ignored. Push it to **its own private repository**, never inside the product repos:

```sh
cd ~/.local/share/ticketsmith/projects/billing && git remote add origin <url> && git push -u origin main
# a teammate:
git clone <url> ~/work/ticketsmith-billing && ticketsmith project link ~/work/ticketsmith-billing
ticketsmith project add tickets       # their own credentials
```

Without git: `ticketsmith project export <dir>` / `project import <dir>`. Secrets never travel.

## Where data lives

Your company's data never enters this repository or the npm package:

| What | Where |
|---|---|
| Active and linked projects | `~/.config/ticketsmith/config.json` |
| A project: `project.yaml` + `knowledge/` (shared), `local/` (SQLite, outputs, audit; never shared) | `~/.local/share/ticketsmith/projects/<name>/` |
| Secrets | System keychain (fallback: `TICKETSMITH_*` variables) |
| Update check | `~/.cache/ticketsmith/update-check.json` (disable with `TICKETSMITH_NO_UPDATE_CHECK=1`) |

## Development

```sh
pnpm install
pnpm dev --help     # runs from src/ without building
pnpm check          # typecheck + lint + architecture + tests
pnpm build          # dist/main.js
```

Start with [docs/architecture.md](docs/architecture.md): layers, folder map, "where do I put X?" and naming conventions. Adding a command or MCP tool: [docs/guides/adding-a-feature.md](docs/guides/adding-a-feature.md). Database integration tests: [docs/guides/local-mysql.md](docs/guides/local-mysql.md). Publishing: [docs/guides/releasing.md](docs/guides/releasing.md).

## License

[MIT](LICENSE)
