# 0018. Product specifics are project data, not design

- **Status:** accepted (2026-10-15)

## Context
Requirements started from the first project and baked its specifics into the design: a fixed number of database shards, two specific repos, one branching model. Other projects will have different databases, hosts and branching.

## Decision
Integrations are generic: any number of named databases (optionally grouped when they share a schema) and any number of repositories on any host, each with its own branches, runtime and test command. Product specifics live in each project's `project.yaml` and `knowledge/`, and appear in the docs only as clearly marked examples.

## Consequences
Code never hardcodes a count, name or branch of a specific product; tests use generic fixtures. ADR 0010 is reworded accordingly.
