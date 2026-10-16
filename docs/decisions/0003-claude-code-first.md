# 0003. Headless Claude Code first, Agent SDK later

- **Status:** accepted (2026-10-15)

## Context
The user has a Claude plan and Claude Code installed.

## Decision
The first `AgentRuntime` invokes the official `claude` binary; an API-key runtime with the Agent SDK comes later behind the same port.

## Consequences
No token extraction from the subscription; switching runtimes is a provider change.
