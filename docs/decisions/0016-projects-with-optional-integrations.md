# 0016. Projects with optional, independent integrations

- **Status:** accepted (2026-10-15)

## Context
Ticketsmith started around a JIRA "profile". The user wants to adopt it per product, sometimes without JIRA at all (only repos, only databases), and to set everything up once.

## Decision
The central concept is a **project** (renaming "profile"). A project has any combination of integrations (ticket source, databases, repositories), none mandatory. `ticketsmith project init` is a resumable onboarding that configures, verifies and **investigates** each chosen integration and writes a project brief. Commands and MCP tools are enabled only when their integrations are configured. Each roadmap phase adds its onboarding step.

## Consequences
Features declare which integrations they need; `doctor` checks only configured ones. Existing profiles are migrated automatically (same keychain entries). Ticket-specific commands explain how to add a ticket source instead of failing obscurely.
