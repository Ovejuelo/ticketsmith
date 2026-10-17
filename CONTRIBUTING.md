# Contributing

Thanks for helping! Ticketsmith is small on purpose: clear layers, pure functions where possible, and tests for everything that matters. This guide gets you from clone to pull request.

## Setup

```sh
git clone https://github.com/Ovejuelo/ticketsmith.git && cd ticketsmith
fnm use              # Node 24 (or any Node >= 24)
pnpm install
pnpm check           # typecheck + lint + architecture + guards + tests: must be green
pnpm dev --help      # runs the CLI from src/, no build
```

Database integration tests need Docker: `pnpm mysql:up && pnpm postgres:up && pnpm test:integration` ([guide](docs/guides/local-databases.md)).

## Find your way

- [docs/architecture.md](docs/architecture.md): layers, folder map and "where do I put X?". Read this first.
- [docs/requirements.md](docs/requirements.md): what Ticketsmith must do and its security principles.
- [docs/decisions/](docs/decisions/): why things are the way they are (ADRs).
- [docs/roadmap.md](docs/roadmap.md): what is next, and what will not be accepted.
- Guides: [adding a feature](docs/guides/adding-a-feature.md), [adding a provider](docs/guides/adding-a-provider.md).

## Rules that keep it healthy

- **Dependencies point one way:** `main → bootstrap → features → core → kernel`. A feature never imports another feature. `pnpm arch` enforces it.
- **A new external system is a provider:** a port in `core/<module>/`, a folder in `providers/<name>/`, wired only in `bootstrap/composition-root.ts`. It is done when it passes its contract suite (databases: `tests/integration/core/database/adapter-contract.ts`).
- **Expected errors are values** (`Result`), zod validates every boundary, and there is no `any`.
- **Tests mirror `src/`** under `tests/unit/`; fakes live in `tests/support/`; no network in unit tests. Write the tests first for guards, converters and masking. Every newly allowed SQL construct needs an adversarial test.
- **Everything in the repo is English.** Fixtures are anonymized: never commit real company data. `pnpm check` runs a private-terms guard.
- **Security first:** no change may give the agent a way to write, post, push or approve by itself. See [SECURITY.md](SECURITY.md).

## Pull requests

- One logical change per PR, with conventional commits (`feat(databases): …`, `fix(tickets): …`, `docs: …`).
- `pnpm check` green, plus the integration tests when you touch `core/database`.
- An architectural change comes with an ADR, and with `docs/architecture.md` and the folder READMEs updated.
- Explain how you verified it (tests, and the real system if you used one).

Good first contributions: a provider for another ticket source, pull request host or database engine; playbooks; masking detectors with anonymized samples; documentation.
