# Ticketsmith

Personal TypeScript CLI that reads tickets (JIRA Cloud first) and drives a Claude agent with its own tools to investigate and resolve them, with human approval for every side effect.

- What and why: @docs/requirements.md
- How the code is organized (layers, folder map, "where do I put X?", naming): @docs/architecture.md
- Phases: `docs/roadmap.md` · decisions: `docs/decisions/` · how-tos: `docs/guides/`

## Language

**Everything written in this repo is in English**: code, identifiers, comments, user-facing CLI messages, test names, docs, commit messages and PR descriptions. Never Spanish, even when the conversation is in Spanish.

## Commands

- `pnpm dev <args>`: runs the CLI from `src/` (Node native type stripping, no build)
- `pnpm check`: typecheck + lint + architecture + tests. **Must be green before finishing any task.**
- `pnpm test`, `pnpm lint:fix`, `pnpm arch`, `pnpm build`
- `pnpm smoke:mcp [KEY]`: runs the MCP server against the real JIRA with the active project
- `pnpm release <patch|minor|major> [--dry-run]`: bumps package + plugin, CHANGELOG, tag and push (docs/guides/releasing.md)
- `pnpm mysql:up` / `pnpm test:integration` / `pnpm mysql:down`: integration tests against a local MySQL (Colima + Docker; `docs/guides/local-mysql.md`). Run them after any change to `core/database`.
- Node 24 via fnm: if `node` is not on the PATH, run `eval "$(fnm env)" && fnm use`

## Project rules

- Side effects (SQL writes, JIRA posts, pushes, PRs) are gated by autonomy levels (requirements §4.9) and always need explicit human approval outside the LLM. The agent can propose, never approve.
- The DB account can write, so protection lives in code: reads go through `readonly-guard` (fails closed, `READ ONLY` transaction, always `ROLLBACK`); writes only through the change-request flow (§4.10: single `INSERT`/`UPDATE … WHERE`, preflight, rollback script, human approval). Never `DELETE` or DDL. No shortcuts.
- The agent never gets DB credentials or a raw connection; passwords are read from the keychain by the Ticketsmith process only.
- Data masking lives inside the tools that hand data to the LLM, not in a separate step.
- Secrets only in the keychain or environment variables; never in logs, prompts, `out/` or audit files. Logs go to **stderr**.
- Company data lives in project folders under `~/.local/share/ticketsmith/projects/` (shared part in each project's own git repo), never in this repo. Everything written to `knowledge/` is masked. Test fixtures are anonymized.
- Integrations are optional, independent and generic (any number of databases/repos): code must work for a project with none of them and never hardcode a product's specifics (e.g. how many shards a product has); those live in the project's config and knowledge (ADR 0018). Commands use `requireTickets` (and later equivalents); tools declare `requires`.
- If unsure about a ticket type, the DB schema or an API's behavior, ask or verify; do not make things up.

## Code style

- Classes only for providers and services with state or dependencies: `implements` the port, constructor injection, `readonly #private` fields, no inheritance, no decorators.
- Pure functions for side-effect-free logic (guard, rules, masking, `adfToMarkdown`, formatting).
- Data = zod schema + `z.infer`, immutable. Zod at every boundary (config, JIRA, LLM output).
- Expected errors as `Result<T, E>` (`src/core/kernel/result.ts`) with unions discriminated by `kind`; `throw` an `AppError` only for the unexpected.
- No `any`, `enum`, parameter properties (`constructor(private x)`) or namespaces: `erasableSyntaxOnly` is on because Node runs the TS directly.
- Relative imports with the `.ts` extension; `import type` for types.
- Commands are thin (options → logic → print); tools return `Result<string, string>` and never mask or audit themselves (`bootstrap/mcp-server.ts` does).
- Biome formatting: 2 spaces, single quotes, no semicolons.

## Architecture (enforced by `pnpm arch` / dependency-cruiser)

`main.ts → bootstrap/ → features/ → core/ → core/kernel/`: dependencies only point right.

- `src/features/<capability>/`: everything one capability needs: `*.command.ts` (CLI), `*.tool.ts` (MCP), plain logic files, and an `index.ts` declaring the `Feature`. Registered in `src/bootstrap/features.ts`.
- **A feature never imports another feature.** Shared code moves to `src/core/<module>/`.
- Outside a module, import only its `index.ts` (the public API).
- Only `src/bootstrap/composition-root.ts` imports `providers/`; everything else depends on ports (`*.port.ts`).
- Role suffixes: `.command.ts`, `.tool.ts`, `.port.ts`, `.schema.ts`; plain names for logic.
- Create a port only when there are two implementations or a fake is needed. No empty folders or modules "for later".
- An architectural change gets an ADR in `docs/decisions/`; keep `docs/architecture.md` and the folder READMEs (`src/features/README.md`, `src/core/README.md`) in sync.

## Tests

- `src/` holds production code only; a `*.test.ts` under `src/` fails `pnpm arch`.
- Unit tests mirror `src/`: the test for `src/features/a/b.ts` is `tests/unit/features/a/b.test.ts`. Moving or renaming a source file moves its test.
- Commands are tested through `FakeCli` (`tests/support/fake-cli.ts`); tools through `createMcpServer` with an in-memory client.
- Fakes and test helpers live in `tests/support/`; anonymized fixtures in `tests/fixtures/`.
- Tests import through the Node subpath aliases `#src/...` and `#tests/...` (package.json `imports`), never `../../..`. Production code keeps relative imports.

## Gotchas

- dependency-cruiser does not support the TypeScript 7 API yet: it uses `parser: 'swc'` and prints an expected `missing-typescript-transpiler` warning. If `pnpm arch` reports "0 modules cruised", something is wrong.
- JIRA Cloud: description and comments come as ADF (JSON), not text. Search is `/rest/api/3/search/jql` with `nextPageToken`; `/rest/api/3/search` is deprecated.
- Scoped JIRA tokens use the gateway `https://api.atlassian.com/ex/jira/{cloudId}`, not the site URL.
- The board (agile) API needs extra scopes (`read:board-scope:jira-software`, `read:project:jira`); without them it returns 401 "scope does not match" and `discover` falls back to a project JQL.
- `ticketsmith mcp` owns stdout for the MCP protocol: never write to stdout from code reachable by it; log to stderr.
- dependency-cruiser's swc parser cannot read `using` declarations: in `src/` use `withProjectDatabase` (or try/finally) instead of `using`. Tests may use `using`.
- node-sql-parser misses MySQL comment tricks (`/*!…*/`, `/*+…*/`, `--x`) and is CommonJS without named ESM exports (load it with `createRequire`). Never run raw SQL: only the `GuardedQuery` regenerated by `guardReadQuery` (ADR 0019). Add an adversarial test for every new SQL construct you allow.
- `git grep -E` uses the platform's POSIX ERE: no `\b`, `\s` or `\w` on macOS. Grep patterns in `repo-map.ts` are loose prefilters; precise matching happens in JS.
- Repository reads go through git objects (`git show`/`git grep <commit>`), never the clone's files: keep it that way so ignored files and symlinks can't leak.
- Claude Code headless (`core/agent/providers/claude-code`): there is no `--max-turns`; `--max-budget-usd` is checked between turns. On errors it still prints the result JSON on stdout with exit 1. Re-verify flags with `claude --help` after Claude Code upgrades.
- The MCP SDK's transport classes don't satisfy `exactOptionalPropertyTypes`: cast them to `Transport` where connected (see `bootstrap/tool-session.ts`).
- Masking favors precision (checksums, structure); add a regression test with a real anonymized sample for every false positive or miss found.

## Workflow

- One roadmap phase at a time (`docs/roadmap.md`); use plan mode for each phase and wait for approval before writing code.
- Tests first for critical pieces (SQL guard, `adfToMarkdown`, masking, rules).
- Conventional commits, one per logical step, with `pnpm check` green. Never commit `.env`, project folders, `out/`, `audit/` or real data. `pnpm check` fails if a source file is git-ignored.
