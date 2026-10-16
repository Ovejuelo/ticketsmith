# Adding a provider (a new external system)

A **provider** is one implementation of a **port**, the interface a core module depends on. Examples: `jira-cloud` implements `TicketSource`; `keyring` and `env` implement `SecretStore`.

## Steps

1. **Port.** If the module has no port for this yet, add `core/<module>/<thing>.port.ts`, an interface plus its error union (`{ kind: … }`). Export it from the module's `index.ts`.
2. **Provider.** Create `core/<module>/providers/<name>/`:
   - a class that `implements` the port (constructor injection, `readonly #private` fields);
   - zod schemas for every external response (`*.schemas.ts`);
   - pure helpers for normalization, tested on their own;
   - an `index.ts` exporting what the composition root needs.
3. **Config.** If the project must describe it, add a variant to the discriminated union in `core/project/project.schema.ts` (`type: '<name>'`), under its optional integration.
4. **Wiring.** Register it in `bootstrap/composition-root.ts`; for ticket sources, add an entry to `connectors`. This is the only file allowed to import `providers/`.
5. **Fake.** If features need to be tested against the port, add an in-memory implementation in `tests/support/`.
6. **Tests.** Under `tests/unit/core/<module>/providers/<name>/`, with fixtures in `tests/fixtures/<name>/` shaped like the real API. Use `FakeFetch` for HTTP; never call the network in unit tests.
7. **Contract suite.** When a port gets its second provider, extract the shared expectations into `tests/contract/<port>.ts` and run both providers through it.

## Checklist

- [ ] Every response is validated with zod; schema errors become `Result` errors with the exact field.
- [ ] Timeouts on every call; retries only on transient errors.
- [ ] Secrets come from `SecretStore`, never from config files, logs or tool outputs.
- [ ] `doctor` checks the new system (`features/doctor/run-checks.ts`).
- [ ] `pnpm check` is green (`pnpm arch` included).
