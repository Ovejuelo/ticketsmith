# 0001. Orchestrator + agent with its own MCP tools

- **Status:** accepted (2026-10-15)

## Context
Investigating a bug or building a report is a loop (search, read, query, decide), and new ticket types keep appearing.

## Decision
Ticketsmith orchestrates a Claude agent that uses Ticketsmith's own tools (served over MCP) plus read-only file tools. Ticket types are Markdown playbooks, not code.

## Consequences
A new ticket type is a playbook; growing autonomy means granting tools. Security lives inside the tools, not in the model's goodwill. Rejected: a fixed pipeline with one coded handler per ticket type.
