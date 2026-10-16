# Ticketsmith — Requirements

> Personal TypeScript CLI that takes tickets (JIRA first), understands them and **prepares** the work: analysis, queries, scripts and comments. It grows through **autonomy levels** until it can resolve tickets on its own, always with human approval for any action that writes.
>
> **What** Ticketsmith must do and **why**. How the code is organized: [architecture.md](architecture.md) · phases: [roadmap.md](roadmap.md) · decisions: [decisions/](decisions/).

**Version:** 2.2 (2026-10-15) · generic integrations (any number of databases and repositories per project); product specifics (such as a product sharded across several databases) are project configuration, not design assumptions.

---

## 1. Goal

| Ticket type | What Ticketsmith does | Output |
|---|---|---|
| **Bug** | Reads the ticket, investigates the repos (read-only) and the DB (`SELECT` only), identifies the probable cause | `analysis.md` (cause, `file:line` evidence, confidence) + `jira_comment.md` |
| **Service request** | Understands the requested change, measures impact with `SELECT`, generates the script with verification and rollback | `script.sql`, `verify.sql`, `README.md` for **manual** execution |
| **Report (Metabase)** | Interprets what the customer asks for, explores the schema and builds the query | `report.sql` with Metabase parameters + `notes.md` with assumptions |
| **New functionality** | Writes a spec and a design plan for approval, then implements it in the back-end and front-end with tests | `spec.md`, `plan.md`, feature branches and (on request) PRs |
| **Other / unknown** | Summarizes, proposes an action and asks how to classify it | Summary + case saved to the knowledge base |

**Design goals, in order:**
1. **Secure by construction:** dangerous capabilities do not exist as code, they are not merely "forbidden".
2. **Useful from the first phase:** every phase ships something usable that same day.
3. **Extensible without rewrites:** a new ticket type is a Markdown playbook; a new provider is a folder.
4. **Measurable:** every change to prompts or playbooks is evaluated against a set of real tickets.
5. **Simple:** nothing is abstracted until there are two implementations or a fake is needed for tests.

---

## 2. Non-negotiable principles (security)

1. **The agent never holds DB credentials or a raw connection.** It only reaches databases through Ticketsmith tools. Accounts may be read-only or write-capable (some teams only have a personal read/write account), so **protection never relies on the account being read-only**: it lives in Ticketsmith. A read-only account per database is always the preferred setup.
2. **Reads: SQL guard in code that fails closed.** Every query goes through `readonly-guard`: it is parsed (never regex), only a single `SELECT` or `WITH … SELECT` is allowed, and **if it cannot be parsed, it is rejected**. It runs inside a `READ ONLY` transaction (enforced by MySQL even for a write-capable user) with a timeout, a default `LIMIT` and an unconditional `ROLLBACK`.
3. **Writes only through autonomy levels** (section 4.9), each gated by an explicit human approval outside the LLM.
4. **SQL writes: proposed by the agent, approved by a human, executed by Ticketsmith.** Only a single `INSERT` or `UPDATE … WHERE` is accepted (no `DELETE`, `REPLACE`, DDL, `LOAD DATA` or multiple statements). The agent cannot approve: approval happens in the user's terminal with the exact SQL, real values, affected rows and a rollback script in view (section 4.10). Claude Code permission prompts never count as approval.
5. **Least-privilege credentials where possible.** JIRA with a **read-only scoped** API token. DB passwords live only in the keychain and are read only by the Ticketsmith process, never exposed through environment variables, files or tool outputs the agent can see (the agent may run `Bash` at L3).
6. **Secrets outside the repo.** System keychain (environment variables as fallback); never in logs, prompts, `out/` or audit files.
7. **Masking at the tool boundary.** DB and ticket data are masked **inside** the tool that hands them to the LLM, not in a separate step the agent could bypass. Repo source code does reach the LLM unmasked; company policy must allow this.
8. **Local audit** of every run: what was queried, **what was sent to the LLM**, which tools the agent used and what was generated.
9. **Company data outside the Ticketsmith repo.** Projects (configuration, knowledge, outputs, audit logs) live in the user's XDG directories; shared knowledge goes to a separate repo per project (§4.1).
10. **Check your company policy** on sending tickets, data and code to an LLM and on using personal tools with company data.

---

## 3. How it works

Ticketsmith is **not** a fixed pipeline with one coded handler per type. It is an **orchestrator** that:

1. Fetches and normalizes the ticket (deterministic code).
2. Classifies it (rules, then the LLM when in doubt) to choose a **playbook** and an **autonomy level**.
3. Launches an **agent** (Claude) with:
   - the **Ticketsmith tools**, exposed by a local MCP server, with the guard and masking built in;
   - Claude's native **read-only** tools (`Read`, `Grep`, `Glob`) over the repo clones;
   - the ticket type's **playbook** as instructions.
4. Validates the agent's structured output (zod) and writes the files.
5. Asks the user for confirmation and, if applicable, saves the case to the knowledge base.

```
ticketsmith process PROJ-123
   │
   ├─ 1. Load project (configured integrations + secrets)
   ├─ 2. TicketSource.getTicket() ──► normalized Ticket (ADF → Markdown)
   ├─ 3. classify(): rules → LLM ──► { type, confidence, reason, playbook }
   ├─ 4. AgentRuntime.run({ playbook, ticket, tools, level })
   │        │
   │        ├─ MCP "ticketsmith": jira_get_issue · jira_search · db_schema
   │        │                     db_select · db_select_group (guard + mask) · knowledge_search
   │        └─ native: Read · Grep · Glob  (cwd = repo clones)
   │
   ├─ 5. Validate output (zod) → write to <project>/local/out/PROJ-123/
   └─ 6. Summary + confirmation: correct classification? save case?
```

**Why:**
- Investigating a bug or building a report is a **loop** (search, read, query, decide), not a linear flow. An agent handles it better than a coded handler.
- **A new ticket type is a Markdown playbook**, not code. Code is only written when a new tool is needed.
- **Growing autonomy = granting more tools** (e.g. `jira_add_comment` at L2), without rewriting the flow.
- Security does not depend on the LLM behaving: the agent has **no path** to the DB other than the guarded `db_select` tools, and in v1 it has no write tools.
- The MCP server can also be used **directly from Claude Code** during development and daily use (`ticketsmith mcp setup`).

Code organization, layers and conventions: [architecture.md](architecture.md).

---

## 4. Functional requirements

### 4.1 Projects, onboarding and storage

A **project** is one product Ticketsmith works on (e.g. `billing`): its integrations, masking rules, autonomy limits and accumulated knowledge.

**Integrations are optional and independent.** A project may have any combination of:

| Integration | Configures | Enables |
|---|---|---|
| Ticket source (JIRA Cloud first) | site, token, JIRA project(s), JQL, custom fields | `list`, `show`, ticket MCP tools, ticket playbooks |
| Databases | any number of named databases, optionally grouped when they share a schema (e.g. 7 shards of one product), credentials in the keychain | DB reads, approved writes, lookups across a group |
| Repositories | any number of git repos (any host): clone URL, protected and base branches, runtime version, test command | repo maps, bug investigation, code changes |

Nothing requires a ticket source: a project with only repos (or only databases) is valid. Commands and MCP tools are available only when the integrations they need are configured; otherwise they explain how to add them (`ticketsmith project add <integration>`). `doctor` checks only what is configured.

**Onboarding** (`ticketsmith project init`): a guided, **resumable** setup. The user picks which integrations to configure; each step configures its integration, verifies it, then **investigates** it and stores the results:

| Step | Investigates and stores |
|---|---|
| Ticket source | Issue types, statuses and workflows, custom fields, components, sample tickets per type |
| Databases | Schema per database, or once per group of databases sharing a schema (tables, columns, relations, indexes), key tables |
| Repositories | Project map per repo: structure, routes/endpoints, models, DB access, tests, how back-end and front-end connect |
| Brief | A **project brief** the agent reads before any task, linking the knowledge above |

`project status` shows what is configured, investigated or pending; `project refresh [step]` re-runs an investigation (e.g. after repo changes); `project add|remove <integration>` changes the integrations later. Each later roadmap phase contributes its own onboarding step.

**Storage — rule: what people edit or share is text; what the machine generates and queries is SQLite.**

```
~/.local/share/ticketsmith/projects/<project>/   ← git-ready project folder
├── project.yaml        integrations and settings, no secrets            (shared)
├── knowledge/          Markdown: brief, repo maps, schema notes,         (shared)
│                       playbooks, cases
├── .gitignore          generated; ignores local/
└── local/              machine-local, never shared
    ├── project.sqlite  schema catalog, ticket-source metadata, onboarding state,
    │                   case index, change requests, run history
    ├── repos/          dedicated clones
    ├── out/            per-ticket outputs
    ├── audit/          JSONL audit logs
    └── cache/
```

- SQLite through Node's built-in `node:sqlite` (no native dependency). It is a cache/state store: everything in it can be rebuilt with `project refresh`.
- **Sharing:** the project folder is a git repository of its own (a **separate repo**, e.g. `ticketsmith-billing`, never inside the product repos). Teammates clone it, run `ticketsmith project link <path>` and add their own credentials; `project export|import` cover machines without git access.
- **Secrets** stay in the system keychain under `ticketsmith/<project>/<name>` (env fallback `TICKETSMITH_*` for CI and evals), never in `project.yaml`, SQLite, knowledge or logs.
- The active project lives in `~/.config/ticketsmith/config.json`; select with `--project <name>` or `TICKETSMITH_PROJECT`, or pin with `ticketsmith project use <name>`.
- Every integration declares its `type` (`"jira-cloud"`, `"mysql"`, `"git"`…) and is validated with a **zod discriminated union**; config errors report the exact path of the invalid field.
- Projects never share knowledge, outputs or credentials.
- Migration: existing profiles (`~/.config/ticketsmith/profiles/*.json`) are converted to projects automatically, keeping their keychain entries.

### 4.2 Ticket source: JIRA Cloud (first integration)

**Authentication (v1):**
- **Recommended: scoped API token** with read-only scopes (`read:jira-work`, `read:jira-user`; add `read:board-scope:jira-software` and `read:project:jira` to read boards). With scoped tokens, calls go through the gateway `https://api.atlassian.com/ex/jira/{cloudId}/rest/...`; the `cloudId` is obtained from `https://<site>.atlassian.net/_edge/tenant_info`.
- **Alternative: classic API token** (unscoped), with calls straight to `https://<site>.atlassian.net/rest/...`. It inherits all of the user's permissions.
- Both use Basic auth `email:token`. Tokens expire (1 year max); `doctor` warns when expiry is near, if the date was configured.
- **Later:** OAuth 2.0 (3LO), which may require admin approval, and JIRA Data Center with a PAT (API v2, wiki markup) as a second `TicketSource` provider.

**Endpoints (API v3):**

| Use | Endpoint | Notes |
|---|---|---|
| Verify credentials | `GET /rest/api/3/myself` | `doctor` |
| List projects | `GET /rest/api/3/project/search` | Paginated (`startAt`/`maxResults`) |
| List boards | `GET /rest/agile/1.0/board` | Paginated; filter by project |
| Board filter/JQL | `GET /rest/agile/1.0/board/{id}/configuration` | To derive the default JQL |
| Search tickets | `GET /rest/api/3/search/jql` | **Do not use** `/rest/api/3/search` (deprecated). Paginated with `nextPageToken`; request only the needed `fields` |
| Ticket detail | `GET /rest/api/3/issue/{key}?fields=…&expand=names` | `names` maps `customfield_*` to readable names |
| Comments | `GET /rest/api/3/issue/{key}/comment` | Paginated |
| Fields | `GET /rest/api/3/field` | To map custom fields in the project |
| Attachments | `GET /rest/api/3/attachment/content/{id}` | On demand only, with a size limit |

**Normalization:**
- `description` and comments come as **ADF (Atlassian Document Format)**, which is JSON. The pure function `adfToMarkdown` converts them to Markdown and covers: paragraphs, headings, lists, code, quotes, tables, panels, links, mentions, emojis, dates, status and media (as an `[attachment: name]` reference). **An unknown node degrades to its plain text and never throws.** Tests use real anonymized ADF fixtures.
- The normalized `Ticket` (zod) includes: `key`, `url`, `type`, `status`, `priority`, `summary`, `description` (Markdown), `labels`, `components`, `reporter`, `assignee`, `created`, `updated`, `comments[]`, `attachments[]` (metadata), `customFields` (only those mapped in the project, with readable names) and `links[]`.
- Useful custom fields (module, customer, environment) are mapped in the project config: `{ "module": "customfield_10042" }`.

**Robustness:**
- Honor `429` and `Retry-After` with exponential backoff and jitter; retry only transient errors (`429`, `5xx`, network).
- Per-request timeout (`AbortSignal.timeout`).
- Every response is validated with zod; schema errors are reported as a `Result` with the exact field.

**Discovery:** `ticketsmith jira discover` lists projects and boards, lets you pick, and stores the JIRA project, board and derived JQL in the Ticketsmith project (the JQL can be edited by hand).
- From a board: board → saved filter JQL → `(<filter>) AND statusCategory != Done ORDER BY priority DESC, updated DESC`.
- If the token cannot use the agile API (missing Jira Software scopes), it warns and falls back to `project = "<KEY>" AND statusCategory != Done ORDER BY priority DESC, updated DESC`.
- `--fields` maps custom fields to readable aliases included in every ticket.

**Read-only in v1.**

### 4.3 Classification
- **Rules first** (pure function): `issuetype`, labels, components, custom fields and keywords, configurable in `knowledge/ticket-types.md` (YAML front matter).
- **LLM when in doubt:** structured output validated with zod `{ type, confidence, reason, playbook }`.
- Below the project's confidence threshold (default `0.75`), the user is asked and the decision is recorded as a case.

### 4.4 Agent and playbooks
- `AgentRuntime.run({ prompt, playbook, outputSchema, mcpConfig, model, maxBudgetUsd, timeoutMs })` → `Result<AgentRun, AgentError>` (`core/agent`, ADR 0022).
- **v1: `ClaudeCodeCliRuntime`**, which invokes Claude Code headless and uses your plan (flags verified on Claude Code 2.1.301):
  - `claude -p --output-format json --json-schema <schema> --append-system-prompt <playbook> --mcp-config <json> --strict-mcp-config --restricted --permission-prompts none --no-session-persistence --disable-slash-commands --max-budget-usd N`;
  - **no built-in tools** (`--tools ""`): the agent reaches tickets, data, code and knowledge only through the Ticketsmith MCP tools (`--allowedTools mcp__ticketsmith__*`), so everything it sees is masked and audited, and ignored files such as `.env` are out of reach;
  - it runs from an empty temporary folder (no project's `CLAUDE.md` or settings) and without `TICKETSMITH_*` environment variables.
- **Tools served in-process:** for each run, Ticketsmith serves its MCP tools on `127.0.0.1` (random port, random bearer token, DNS-rebinding protection), so the session vault stays in the Ticketsmith process. The agent's answer is then **revealed** for local files (`out/`): real values replace placeholders, except `[SECRET_n]`, which stay masked. Knowledge written by the agent is never revealed, because it is shared.
- **Playbooks:** built-in `bug` and `repo-analysis`; a project overrides or adds one with `knowledge/playbooks/<name>.md`.
- **Later: `AgentSdkRuntime`** with `@anthropic-ai/claude-agent-sdk` and an API key, for unattended or CI runs.
- The subscription token is **never** extracted for use from our own code; the subscription path only invokes the official `claude` binary. Confirm Anthropic's current terms.
- Agent output is requested as JSON (zod schema → JSON Schema) and validated; if invalid, it retries once with the error and then reports it.
- Per-run limits in `project.yaml` (`agent.maxBudgetUsd`, default 3; `agent.timeoutMinutes`, default 20; optional `agent.model`); `process --budget` and `--model` override them. Claude Code has no max-turns flag and checks the budget between turns, so a run can end slightly above it.

### 4.5 MCP server (`ticketsmith mcp`)
v1 tools, all read-only:

| Tool | What it does | Safety |
|---|---|---|
| `jira_get_issue` | Normalized ticket as Markdown | Masked |
| `jira_search` | JQL → summarized list | Masked; result limit |
| `db_schema` | Tables of a database/group, or one table's columns, keys, FKs, indexes and referrers (from the catalog) | No data; never touches the database |
| `db_select` | One guarded `SELECT` on one database | Placeholders resolved server-side → guard → `READ ONLY` tx → time limit → `LIMIT` → `ROLLBACK` → mask |
| `db_select_group` | The same guarded `SELECT` on every database of a group (e.g. find the pod holding an account) | Same as `db_select`; failures per database reported without hiding the rest |
| `repo_list` | Repositories, base branches, clone commit, runtime, test command, map file | — |
| `repo_files` / `repo_search` / `repo_read` | List tracked files (glob), `git grep` across repositories, read a file with line numbers, at any ref | Tracked content only (git objects); refs and paths validated; masked |
| `db_propose_change` | Proposes one INSERT/UPDATE for human approval (only on databases with `allowChanges`) | Write guard → read-only preflight → stored change request; never executes |
| `knowledge_read` / `knowledge_search` | Read a knowledge file (`brief.md` first) / search all of them (file:line) | `.md` inside `knowledge/` only (symlinks resolved); content already masked |

Every tool call is recorded in the audit log.

**Masking (implemented in phase 2, `core/security`):**
- Built-in detectors, applied in this order: `secret` (JWT, Bearer/Basic, Stripe, AWS, GitHub, Atlassian, Slack keys, `password=`-style pairs, URL credentials) → `email` → `curp` → `rfc` → `clabe` → `card` → `phone`.
- Precision over recall: RFC dates are validated, CLABE check digits verified, cards must pass Luhn, and phones need a `+` prefix or separators. Bare 10-digit numbers, ticket keys, dates, amounts, UUIDs and folios stay visible. SAT's generic RFCs (`XAXX010101000`, `XEXX010101000`) stay visible because they identify nobody.
- Corporate email domains stay visible (`[EMAIL_1]@northwind.mx`) so the agent knows the customer; public providers (gmail, hotmail, outlook…) are fully hidden. Configurable with `masking.keepEmailDomains` (default `true`).
- **Session vault (pseudonymization):** placeholders are consistent for the whole MCP session, not just per response. Tools resolve placeholders in their inputs server-side (JQL now, SQL in phase 5), so the agent can look up accounts by email without ever seeing it. Outputs re-mask every value the vault has seen, even where no detector matches. Placeholders the vault never issued are rejected. The vault lives only in memory and is never written to disk or the audit log.
- Customer and person names are **not** masked (decision of 2026-10-15): the agent needs them for context.
- Per project: `masking.detectors` (default: all) and `masking.custom` (`{ label, pattern }` regex rules; invalid patterns are rejected when the project loads).
- `show --mask` applies the same rules for `show X | claude`.

### 4.6 Reports playbook (Metabase)
- Interprets columns, filters, dates and groupings; explores the schema with `db_schema` and validates the query with `db_select` (with `LIMIT`).
- Output: `report.sql` with Metabase parameters (`{{start_date}}`) and `notes.md` with assumptions and open questions.

### 4.7 Service requests playbook
- Identifies the action and measures with `db_select` the current state and how many rows would be affected.
- Generates `script.sql` (transaction with `ROLLBACK` by default and a commented-out `COMMIT`), `verify.sql` (before/after) and `README.md` with the impact.
- Mandatory header: `-- REVIEW BEFORE RUNNING - generated by ticketsmith`.
- With autonomy L2-DB the agent may instead propose the change with `db_propose_change`; it runs only after human approval (§4.10). `script.sql` itself is never executed.

### 4.8 Bugs playbook
- Extracts symptom, steps, module, endpoint or screen, dates and IDs.
- Investigates the repos with `Read/Grep/Glob` and queries the DB with `db_select` when needed.
- Output: `analysis.md` (probable cause, `file:line` evidence, confidence level, next steps) and `jira_comment.md`.
- Repos are analyzed on **dedicated clones** (see §4.11) so the user's own working copies are never touched. At L3 the agent may fix the bug in a per-ticket worktree (§4.9).

**Phase 6 (`ticketsmith process <KEY>` / `--next`):** the `bug` playbook (or `--playbook <name>`) runs with every tool the project's integrations allow and writes `out/<KEY>/ticket.md`, `ticket.json`, `analysis.md` (summary, probable cause, confidence, evidence, next steps, open questions), `jira_comment.md` (to paste by hand: posting is L2) and `run.json` (cost, turns, duration, tool calls; no content). `project refresh repos --deep` has the agent write `knowledge/repos/<name>.analysis.md` (modules, flows, business rules, data model, risks, glossary) once per commit.

### 4.9 Autonomy levels

Configurable per project and per ticket type; the effective level is the **minimum** of both.

| Level | The agent can | Requires |
|---|---|---|
| **L0** | Read and analyze | — |
| **L1** | Generate files in `out/` | — (**v1**) |
| **L2** | Post a comment or transition in JIRA (`jira_add_comment`, `jira_transition`) | `y/N` confirmation showing the exact content |
| **L2-DB** | Propose a single `INSERT`/`UPDATE … WHERE` (`db_propose_change`) | Human approval in the terminal (`ticketsmith changes approve <id>`), see §4.10 |
| **L3** | Work in a per-ticket worktree and branch, change code, run tests, then **ask** whether to push and open a PR (never on the repo's protected branches) | Confirmation for push and PR + human PR review |
| **✗** | `DELETE`, DDL, multi-statement SQL, approving its own changes, pushing to protected branches | **Never** |

**Target end state:** the agent works on its own (investigates, queries, edits code, drafts SQL and comments) and the human only approves actions with side effects: SQL writes, JIRA posts, pushes and PRs.

Write tools are only registered in the MCP server when the effective level allows them, so they do not exist for the agent at lower levels.

### 4.10 Approved database writes (change requests)

Flow, designed so that the LLM can propose but never execute or approve:

1. **Propose (agent, MCP tool `db_propose_change`)** with `{ database, sql, reason, ticket, expectedRows }`. Placeholders from the vault are resolved server-side.
2. **Validate (`write-guard`, fails closed):** exactly one `INSERT … VALUES` or `UPDATE … WHERE` statement; no `DELETE`, `REPLACE`, `INSERT … SELECT`, `ON DUPLICATE KEY`, DDL, `LOAD DATA`, variables or functions with side effects; an `UPDATE` without `WHERE` or with an always-true `WHERE` is rejected.
3. **Preflight (read-only):** the `UPDATE`'s `WHERE` becomes a `SELECT` to count and capture the affected rows; `EXPLAIN` checks it uses an index. The captured rows produce a **rollback script**. The change is stored as `changes/<id>.json` (owner-only) and the agent gets back a masked preview and the change id.
4. **Approve (human, `ticketsmith changes show|approve|reject <id>`):** the terminal shows database, ticket, reason, the exact SQL with real values, affected-row count, a sample of current rows and the rollback script. Approval requires typing the database name. Changes expire after 1 hour; the preflight is re-run at approval time.
5. **Execute (Ticketsmith):** inside a transaction; if the affected rows differ from the preflight count, `ROLLBACK` and report; otherwise `COMMIT`. `rollback.sql`, the result and the approval are written to `out/<KEY>/` and the audit log.

The agent has no approve tool. Nothing in the MCP server can turn a proposal into an execution.

**As implemented (phase 7, ADR 0023):**
- Opt-in per database: `allowChanges: true` in `project.yaml` (asked by `project add databases`, flag `--allow-changes`). Without it the database is read-only for the agent, and `db_propose_change` is not even registered when no database allows changes.
- Row limit per change: `changes.maxRows` (default 100, up to 10,000).
- Write guard (`core/database/write-guard.ts`): the read guard's text layer, one statement, one table with a primary key in the investigated catalog, an explicit column list for INSERT, no JOIN / ORDER BY / LIMIT / subqueries / variables, functions limited to NOW, CURRENT_TIMESTAMP, UTC_TIMESTAMP, CONCAT, COALESCE, IFNULL, UPPER, LOWER, TRIM and ROUND. An UPDATE's WHERE must pin rows with an AND-joined `column = literal` or `column IN (literals)`. The regenerated SQL is what runs.
- Changes live in `local/changes/<id>.json` (owner-only, real values). `ticketsmith changes list|show|approve|reject`: approval only in an interactive terminal (no flag), re-runs the guard and the preflight, shows real values and requires the database name typed back.
- Execution: `SET SESSION transaction_read_only = OFF`, `START TRANSACTION READ WRITE`, the statement, `COMMIT` only if `affectedRows` (matched rows) equals the preflight count, otherwise `ROLLBACK`. The session is set back to read-only before the connection returns to the pool. Output in `out/<KEY>/change-<id>/` (`change.sql`, `rollback.sql`, `preflight.json`, `result.json`); the audit records the SQL's hash, never its values.
- INSERT rollback scripts are written after execution from the new AUTO_INCREMENT ids and contain `DELETE … WHERE pk = …`. They are files for a person; Ticketsmith never runs them, and it never runs DELETE.

### 4.11 Repositories

- A project has **any number of git repositories, on any host**. Per repo: clone URL, protected branches, the base branch for each kind of change (fix, feature), the runtime version and the test command.
- **Dedicated clones** under `<project>/local/repos/`, updated with `git fetch` and kept detached at the fix branch (the code users run). The user's own working copies are never used. Git access uses the user's own SSH key or credential helper; URLs with embedded credentials are rejected. A missing clone (e.g. after `project link` on another machine) is cloned by `project refresh repos`.
- **Runtime per repo** through the version manager (e.g. `fnm` for Node): commands for a repo always run with that repo's version.
- **Project map:** the repositories onboarding step writes `knowledge/repos/<name>.md` (stack, structure, entry points, HTTP endpoints, screens, outgoing calls, models, migrations and SQL, config files, tests), regenerated only when the clone's commit moves, plus `knowledge/repos/_connections.md` matching front-end calls to back-end routes. The map is **deterministic** (built from the code without an LLM, phase 5); phase 6 adds a deeper analysis by the agent on top. The agent reads the map before investigating, instead of rediscovering the project every time.
- **Reading code (MCP):** `repo_list`, `repo_files`, `repo_search` and `repo_read` read **git objects**, not the file system: only tracked content at a validated ref is visible (never ignored files such as `.env`, never `.git/`, and symlinks yield their target path), and outputs are masked like every tool.
- **Code changes (L3, phase 8, ADR 0024):** opt-in per repository (`allowCodeChanges`). `ticketsmith code <KEY>` creates one worktree and branch per ticket from the repo's fix branch, named by `branchPattern` (default `fix/{key}-{slug}`). The agent edits with Claude Code's file tools confined to the worktrees (`--restricted`) and has **no shell**: it runs the repo's configured `testCommand` only through `code_run_tests` (repo runtime via fnm, credentials stripped from the environment, timeout `code.testTimeoutMinutes`). Ticketsmith commits, re-runs the tests itself and writes `out/<KEY>/code/` (`summary.md`, `<repo>.diff`, `run.json`). Pushing happens only after a yes in an interactive terminal, with an explicit refspec, never forced, never to protected, base or target branches. Pull requests open through a host provider (GitHub, incl. Enterprise via `host.apiUrl`, and Bitbucket Cloud; token in the keychain as `git-host-<host>`), or, for any other host or without a token, as the host's link plus the text to paste. PR text stays masked; the local summary is revealed.

> **Example:** two Bitbucket repos, `billing-backend` (Node 20, Express) and `billing-frontend` (React 16, Node 14); long-lived branches `master` (production), `stage`, `develop`; fixes are hotfixes branched from `master` (`hotfix/<KEY>-<slug>`).

### 4.12 Knowledge base
`<project>/knowledge/`, in Markdown/YAML, shared through the project's own git repo (§4.1):
- `ticket-types.md`: types, signals and classification rules (YAML front matter).
- `playbooks/<type>.md`: how each type is resolved, which tools to use and the output format.
- `schema-notes.md`: data model notes the schema does not tell (states, soft deletes, multi-tenancy…).
- `cases/<KEY>.md`: resolved and approved cases (ticket → classification → solution).

It is not training: it is **curated context** that grows with use.

### 4.13 Evaluations
- Per-project `evals/`: real resolved tickets (anonymized) with the expected classification and the real solution.
- `ticketsmith eval [--type report]` runs the set and reports: classification accuracy, output validity (schema), queries passing the guard and, optionally, an LLM judgment against the real solution.
- Run before and after changing a playbook, prompt or model. No autonomy level is raised for a type without evals.

### 4.14 Audit
One JSONL file per run in `audit/` with: command, project, ticket, classification, prompts sent (with masking applied), tool calls (input and output summary), generated files, duration, tokens and cost when available. Secrets are redacted.

---

### 4.15 New functionality playbook

New functionality is larger and more ambiguous than a hotfix, so it adds a **design checkpoint before any code is written**.

1. **Understand:** read the ticket, the linked tickets, the project maps (§4.11) and the relevant data (DB reads), then list assumptions and **clarifying questions**. Unanswered questions block the next step.
2. **Spec:** `spec.md` with the expected behavior, acceptance criteria and out-of-scope items, in terms the requester would recognize.
3. **Plan (human approval):** `plan.md` with the changes per repo (back-end endpoints, models, front-end screens), schema changes, tests to add, risks and rollout notes. **No code is written until the human approves the plan**; a rejected plan returns to step 1 or 2 with the feedback.
4. **Implement:** one worktree per affected repo, branched from the feature base branch, with branch names that tie them together (`feature/<KEY>-<slug>`). Schema changes are **migration files in the repo**, reviewed in the PR; DDL is never run against the project's databases.
5. **Verify:** run the repos' test suites plus the new tests the agent wrote; report anything that could not be verified automatically.
6. **Deliver:** summarize the changes against the acceptance criteria, then **ask** whether to push and open the PRs (one per repo, cross-linked and linked to the ticket).

Autonomy: steps 1–3 are L1 (files only); steps 4–6 are L3 (§4.9).

### 4.16 Distribution
- Public repository (MIT) and npm package `ticketsmith` containing only the bundle; company data never enters either (guarded by `scripts/guard-private-terms.ts`).
- A Claude Code plugin and marketplace in the same repository: the plugin runs `npx -y ticketsmith@latest mcp` and ships skills, so users get new releases without reinstalling.
- The CLI announces new releases on stderr, at most once a day, never from `mcp`, `--json`, CI or non-terminals.
- Releases are cut with `pnpm release` and published by a tag-triggered workflow with provenance (ADR 0020).

## 5. Commands

| Command | Phase | Description |
|---|---|---|
| `ticketsmith project init` | 3 | Guided, resumable onboarding: pick integrations, configure, verify and investigate them |
| `ticketsmith project status\|refresh\|add\|remove` | 3 | What is configured/investigated; re-investigate; change integrations |
| `ticketsmith project list\|use\|show\|link\|export\|import` | 3 | Project management and sharing (replaces `init` and `profile` from phase 1) |
| `ticketsmith doctor` | 1+ | Checks every configured integration (ticket source, each database, each repo, `claude`) |
| `ticketsmith jira discover` | 1 | Pick the JIRA project and board and store the JQL (part of onboarding from phase 3) |
| `ticketsmith list` | 1 | Tickets from the project's JQL (needs a ticket source) |
| `ticketsmith show <KEY>` | 1 | Normalized ticket as Markdown (stdout or `--out`) |
| `ticketsmith classify <KEY>` | 10 | Classify only |
| `ticketsmith process <KEY>` / `--next` | 6 | End-to-end processing |
| `ticketsmith mcp` | 2 | stdio MCP server |
| `ticketsmith db ask "<sql>" [--db\|--group]` | 4 | Runs a guarded `SELECT` on a database or a whole group |
| `ticketsmith changes list\|show\|approve\|reject <id>` | 7 | Reviews and approves (interactively) or rejects the database changes the agent proposed |
| `ticketsmith code <KEY>` / `code push\|status\|discard` | 8 | Fixes a ticket in code in a worktree per repository, then pushes and opens PRs when you agree |
| `ticketsmith knowledge add <KEY>` | 10 | Saves a resolved case |
| `ticketsmith eval` | 10 | Runs the evaluations |

Global options: `--project`, `--json` (machine-readable output), `--verbose`.

**Per-ticket output:** `<project>/local/out/<KEY>/` with `ticket.md`, `ticket.json`, `classification.json` and, depending on type, `analysis.md`, `jira_comment.md`, `script.sql`, `verify.sql`, `report.sql`, `notes.md` and `README.md`.

---

## 6. Databases

- **Any number of named databases per project**, each with its engine (`type`), host, port, database and user; each password lives in the keychain under `ticketsmith/<project>/db-<name>`.
- **Groups (optional):** databases that share a schema can be grouped. The schema is investigated once per group, and group tools can run the same read query on every member (bounded concurrency), e.g. to find which database holds an account.
- **Network:** Ticketsmith does not manage VPNs or tunnels; connection errors are reported as "database unreachable (is the VPN/tunnel up?)" and `doctor` checks every database.
- **Accounts:** read-only or write-capable; `doctor` reports for each database whether the account can write, as a standing reminder. Protection is the same either way (§2).
- **First engine:** MySQL 8. Others arrive as providers with their own guard rules and the `DatabaseAdapter` contract suite.

> **Example:** 7 shards (`shard1` … `shard7`), one MySQL 8 database each, all in one group because they share the schema, reachable only through the company VPN, accessed with the user's read/write account (no delete). Tickets usually name the shard; otherwise a group lookup finds the account.

- **MySQL read guard (`core/database/readonly-guard.ts`, ADR 0019)**, failing closed:
  - **Text layer** (string literals skipped): reject executable comments `/*! … */` and `/*M! … */`, optimizer hints `/*+ … */` (could override the time limit) and `--` not followed by whitespace. The parser treats all of these as comments while MySQL executes them: `SELECT /*!50000 SLEEP(1) */ 1` and `SELECT 1 --1, SLEEP(10)` both looked like `SELECT 1` to the parser.
  - **Tree layer:** exactly one statement, of type `SELECT` (including `WITH … SELECT` and `UNION`); walk every node (subqueries, CTEs, UNION branches) and reject `INTO` (files or variables), locking reads, `:=` assignments, `@`/`@@` variables, nested statements and waiting/locking/file functions (`SLEEP`, `BENCHMARK`, `GET_LOCK`, `LOAD_FILE`…). **If it does not parse, it is rejected.**
  - **What runs is regenerated from the validated tree**, never the raw text, so whatever the parser did not see cannot execute.
  - `LIMIT maxRows+1` is added when missing (to report truncation); a larger `LIMIT` is rejected. Defaults: 200 rows, max 1000.
- **Execution (`MysqlDatabaseAdapter`):** `SET SESSION MAX_EXECUTION_TIME = …, transaction_read_only = ON` (a read-only *session* is required: inside a mere `START TRANSACTION READ ONLY`, DDL commits implicitly and runs, verified on MySQL 8.0 and 8.4.9), then `START TRANSACTION READ ONLY`, exactly one statement with a client timeout, and **always `ROLLBACK`**; the pool refuses multi-statement batches and read-only mode is re-applied on every call. The adapter only accepts a `GuardedQuery`, so raw SQL does not even compile.
- **Introspection** via constant `information_schema` queries, once per group, stored in the project's SQLite catalog and in `knowledge/databases/<target>.md`.
- Writes follow §4.10 only.

---

## 7. Access and prerequisites

Per project, only for the integrations it uses:

- [ ] **Ticket source (JIRA Cloud):** site URL, email and a **scoped API token** with `read:jira-work` and `read:jira-user` (plus `read:board-scope:jira-software` and `read:project:jira` for boards); the JIRA project(s) and board; useful custom fields.
- [ ] **Databases:** for each one, engine, host, port, database and user (read-only preferred), and network access (VPN or tunnel).
- [ ] **Repositories:** clone URLs, protected and base branches, test commands, runtimes installed (e.g. via `fnm`); for PRs, an API token for the host.
- [ ] 2–3 real resolved tickets per type for fixtures and evals, anonymized before entering the repo.
- [ ] Company policy reviewed regarding LLMs + ticket data, database data and code.

Always: Node 24 (via `fnm`) and pnpm; Claude Code installed and logged in.

> **Example:** host/port/database/user for each of the 7 shards with the VPN connected; clone URLs for both repos with Node 14 and 20 installed; a Bitbucket API token with pull request write access.

---

## 8. v1 acceptance criteria (phases 0–8)

- [ ] No code path writes to the DB except an approved change request (§4.10): read and write guards have adversarial tests, the agent has no other route to the DB and no way to approve.
- [ ] `doctor` checks every configured database (reachability, credentials, write capability reported).
- [ ] One ticket of each type produces the expected files in `out/`.
- [ ] Every service request script includes verification and rollback, and is never executed automatically.
- [ ] An unknown ticket asks the user and is saved as a case.
- [ ] Secrets absent from logs, `out/` and `audit/` (verified by tests).
- [ ] Module boundaries and absence of cycles are verified in CI.
- [ ] `eval` reports metrics per type and there are no regressions when playbooks change.
- [ ] Adding a new ticket type requires no code: only a playbook and rules.

---

## 9. Open questions

1. ~~Which data is sensitive and must be masked?~~ Resolved: emails, phones, RFC/CURP, CLABE, cards and secrets; names stay visible (§4.5).
2. Metabase only for pasting queries, or creating questions via API later?
3. ~~Company policy on LLMs with tickets, data and code?~~ Resolved for the first project: the company provides Claude and already uses it with its information and databases. Each team must check its own policy.
4. Is there a read replica of the DB?
5. Will there be customers besides your company (a second project) in the short term?
