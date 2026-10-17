# Architecture decisions

One file per decision (ADR), numbered and never renumbered. To change a decision, add a new ADR that supersedes the old one and mark the old one `superseded by NNNN`.

Template: `# NNNN. Title` · **Status** · **Context** (why it came up) · **Decision** (what we chose) · **Consequences** (what it implies, what was rejected).

| # | Decision |
|---|---|
| [0001](0001-agent-with-mcp-tools.md) | Orchestrator + agent with its own MCP tools |
| [0002](0002-jira-cloud-scoped-token.md) | JIRA Cloud first, with a read-only scoped API token |
| [0003](0003-claude-code-first.md) | Headless Claude Code first, Agent SDK later |
| [0004](0004-biome-and-dependency-cruiser.md) | Biome for lint/format, dependency-cruiser for architecture |
| [0005](0005-native-type-stripping.md) | Node type stripping + tsdown instead of tsx + tsup |
| [0006](0006-single-package.md) | Single package, not a monorepo |
| [0007](0007-company-data-in-xdg.md) | Company data lives in XDG directories, never in the repo |
| [0008](0008-autonomy-levels.md) | Autonomy levels instead of 'never writes' |
| [0009](0009-english-only.md) | Everything in the repo is in English |
| [0010](0010-write-capable-db-account.md) | Support write-capable DB accounts, protected by Ticketsmith |
| [0011](0011-approved-sql-writes.md) | The agent proposes SQL writes, a human approves them in the terminal |
| [0012](0012-session-placeholder-vault.md) | Session vault resolves masked values server-side |
| [0013](0013-vertical-slices.md) | Organize by feature (vertical slices) over a shared core |
| [0014](0014-tests-outside-src.md) | Tests outside src, mirroring it |
| [0015](0015-new-functionality-with-design-checkpoint.md) | New functionality with a design checkpoint |
| [0016](0016-projects-with-optional-integrations.md) | Projects with optional, independent integrations |
| [0017](0017-git-ready-project-storage.md) | Git-ready project folder: shared text + local SQLite |
| [0018](0018-product-specifics-are-project-data.md) | Product specifics are project data, not design |
| [0019](0019-two-layer-read-guard.md) | Two-layer read guard that executes the regenerated SQL |
| [0020](0020-npm-and-plugin-marketplace.md) | Distribution through npm and a Claude Code plugin marketplace |
| [0021](0021-repositories-read-from-git-objects.md) | Repositories: dedicated clones, reads from git objects, deterministic maps |
| [0022](0022-agent-runtime-mcp-only.md) | Agent runs: Claude Code headless with only Ticketsmith's tools, served in-process |
| [0023](0023-approved-database-changes.md) | Approved database changes: write guard, preflight and terminal approval |
| [0024](0024-code-changes-in-worktrees.md) | Code changes in ticket worktrees: confined file tools, no shell, pushes on approval |
| [0025](0025-new-functionality-design-checkpoint.md) | New functionality: questions, one design run and plan approval before any code |
| [0026](0026-classification-cases-and-evals.md) | Classification, resolved cases and evals |
