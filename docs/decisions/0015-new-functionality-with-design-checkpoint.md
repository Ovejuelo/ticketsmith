# 0015. New functionality with a design checkpoint

- **Status:** accepted (2026-10-15)

## Context
Besides hotfixes and service requests, the agent should implement new functionality tickets in the project's repositories (first: a back-end and a front-end repo). These are larger and more ambiguous, often span both repos and may need schema changes.

## Decision
A dedicated playbook (requirements §4.15): clarifying questions, `spec.md`, then a `plan.md` the human must approve **before any code is written**; implementation in cross-linked worktrees from the feature base branch, new tests, schema changes only as migration files in the repo, and PRs only after asking. It reuses the building blocks of earlier phases (tickets, DB reads, repo maps, worktrees, PRs) and comes after code changes (L3).

## Consequences
Two human checkpoints (plan and PR) instead of one. DDL against the project's databases stays impossible; schema changes go through normal code review. Open: feature base branch, migration tooling, test coverage of the repos.
