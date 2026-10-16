# 0008. Autonomy levels instead of 'never writes'

- **Status:** accepted (2026-10-15)

## Context
The goal is an agent that resolves tickets, which requires side effects.

## Decision
Side effects (SQL writes, JIRA posts, pushes, PRs) are unlocked per level and always need explicit human approval outside the LLM.

## Consequences
The agent works alone and the human approves side effects; `DELETE`, DDL and self-approval stay impossible.
