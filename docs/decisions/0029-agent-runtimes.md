# 0029. Agent runtimes: signed-in Claude Code or the Agent SDK with an API key

- **Status:** accepted (2026-10-17)

## Context
Runs use the official `claude` binary with the user's plan (ADR 0022). Unattended runs (CI, scheduled evals) have nobody signed in and need an API key instead. Requirements §4.4 planned an `AgentSdkRuntime` for that.

## Decision
- `agent.runtime` per project: `claude-code` (default) or `sdk`. `Services.agentFor(project)` picks the runtime, so commands do not care which one runs.
- `AgentSdkRuntime` keeps every guarantee of the CLI runtime:
  - no built-in tools (only the confined file tools for code runs, never Bash);
  - only the Ticketsmith MCP server (`strictMcpConfig`);
  - no settings or CLAUDE.md from disk (`settingSources: []`);
  - no prompts and nothing persisted;
  - a JSON-schema answer, the budget, and a time limit through an `AbortController`.
- The Anthropic API key lives in the keychain as `anthropic-api-key` (env `TICKETSMITH_ANTHROPIC_API_KEY`). It is passed only to the agent process, and Ticketsmith's other secrets are filtered out of that environment. `project agent` changes the runtime and limits and stores the key; `doctor` checks the configured runtime.
- The SDK ships a large native Claude Code binary, so it is an **optional peer dependency**, loaded on first use with a clear message when it is missing. Projects on `claude-code` never download it.

## Consequences
CI can run evals and playbooks with an API key and the same tool boundary. The SDK's options are mapped to the CLI flags one to one; a new SDK option that loosens the boundary must be reviewed before it is used. The subscription token is still never read by Ticketsmith.
