# 0022. Agent runs: Claude Code headless with only Ticketsmith's tools, served in-process

- **Status:** accepted (2026-10-16)

## Context
Phase 6 makes Ticketsmith drive the agent itself (`process <KEY>`, `project refresh repos --deep`) instead of waiting for a person in Claude Code. Requirements first proposed giving the agent Claude's native `Read`/`Grep`/`Glob` over the clones. Those read the file system unmasked, including ignored files such as `.env`, and outside Claude Code's working directory they need permission prompts nobody can answer headless. The agent's answer is also meant for a person (a JIRA reply), and placeholders like `[EMAIL_1]` make it unusable as is.

## Decision
- **Runtime:** `ClaudeCodeCliRuntime` runs the official `claude` binary with the user's own login: `-p` with `--json-schema` (structured output), the playbook via `--append-system-prompt`, `--restricted`, `--strict-mcp-config`, `--permission-prompts none`, `--no-session-persistence`, `--disable-slash-commands` and `--max-budget-usd`. It runs from an empty temporary folder, with `TICKETSMITH_*` variables removed from its environment. A timeout kills it. zod validates the answer, and an invalid answer is retried once with the problems.
- **No built-in tools** (`--tools ""`): the agent reaches tickets, databases, code and knowledge only through the Ticketsmith MCP tools, which mask, audit and confine every read. `knowledge_read` and `knowledge_search` were added so it can read the brief, maps and schemas.
- **Tools served in-process over local HTTP** (`bootstrap/tool-session.ts`): 127.0.0.1, a random port, a random bearer token per run, DNS-rebinding protection and one session. The placeholder vault therefore lives in the Ticketsmith process for the whole run.
- **Reveal for local files only:** after the run, `vault.reveal` puts real values back into the answer written to `out/<KEY>/` (owner-only files). `[SECRET_n]` is never revealed. Knowledge written by the agent (`*.analysis.md`) is never revealed, because it is shared.
- **Playbooks** are Markdown: built-ins `bug` and `repo-analysis`, overridden or extended by `knowledge/playbooks/<name>.md`.

## Consequences
The agent can only do what Ticketsmith's tools allow, and everything it sees is in the audit log. Outputs are ready for a person to review and paste. A run depends on Claude Code's CLI flags, which `doctor` and the tests pin; upgrades must be checked with `claude --help`. Claude Code has no max-turns flag and checks the budget between turns, so a run can end slightly above its budget. A later `AgentSdkRuntime` implements the same port for unattended runs.
