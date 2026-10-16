# 0020. Distribution through npm and a Claude Code plugin marketplace

- **Status:** accepted (2026-10-16)

## Context
Ticketsmith must be installable by anyone, on any machine (the first live tests run on a different Mac, behind a company VPN), and users should get new versions as development continues, the way Claude Code skills and MCP servers are installed. The repository had company data in its tests, docs and history.

## Decision
- **Public repository, MIT.** It starts from a fresh history; the old history stays only on the maintainer's machine. Examples and fixtures are fictional. `scripts/guard-private-terms.ts` blocks private terms listed in a git-ignored `.private-terms`.
- **npm package `ticketsmith`** with the bundled `dist/main.js` only. It is published by a tag-triggered workflow with provenance, through npm trusted publishing (OIDC). The CLI shows an update notice on stderr, at most once a day, never in `mcp`, `--json`, CI or non-terminals.
- **Claude Code plugin and marketplace in the same repository** (`.claude-plugin/marketplace.json` → `plugin/`). The plugin's MCP server runs `npx -y ticketsmith@latest mcp`, so sessions pick up new releases without reinstalling. Skills ship in `plugin/skills/`. `claude plugin validate --strict` runs in CI.
- **One version** for the package and the plugin, bumped together by `pnpm release`.

## Consequences
Installing is two commands, and updates need no action for the MCP server. `@latest` means a broken release reaches every user's next session: releases run the full check, and a bad one is fixed by publishing a patch (or `npm deprecate`). Each user keeps their own credentials and project data on their machine; nothing company-specific ships in the package.
