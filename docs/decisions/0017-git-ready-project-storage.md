# 0017. Git-ready project folder: shared text + local SQLite

- **Status:** accepted (2026-10-15)

## Context
Project configuration and investigation results must persist per project and be shareable later through a repository, without leaking secrets or machine-specific state.

## Decision
Rule: **what people edit or share is text; what the machine generates and queries is SQLite.** Each project is a folder `~/.local/share/ticketsmith/projects/<name>/` with `project.yaml` and `knowledge/` (shared, versioned in a **separate git repo per project**) and `local/` (ignored: `project.sqlite` via Node's built-in `node:sqlite`, clones, outputs, audit, cache). Secrets stay in the keychain.

## Consequences
Teammates clone the project repo and run `project link`, adding their own credentials. SQLite is a rebuildable cache (`project refresh`), so it is never shared. Rejected: everything in SQLite (no diffs, not editable by hand, not reviewable in a PR); a folder inside the product repos (mixes company knowledge with product code).
