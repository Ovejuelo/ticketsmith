## What and why

## How it was verified
- [ ] `pnpm check` is green
- [ ] Integration tests, if `core/database` changed
- [ ] Checked against the real system (say which), or why not

## Checklist
- [ ] Tests mirror `src/`; adversarial tests for any newly allowed SQL
- [ ] No real company data, tokens or names in code, fixtures or docs
- [ ] The agent gains no way to write, post, push or approve by itself
- [ ] ADR and `docs/architecture.md` updated if the architecture changed
