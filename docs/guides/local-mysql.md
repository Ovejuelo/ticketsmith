# Testing against a real MySQL

Unit tests use a fake driver. Integration tests in `tests/integration/` run the database code against a real MySQL and are **skipped** unless `TICKETSMITH_TEST_MYSQL_URL` is set, so `pnpm check` never needs Docker.

## Setup (macOS, once)

Colima + the Docker CLI: free, light (a VM you size yourself) and fully Docker-compatible. Docker Desktop and OrbStack need paid licenses for company use.

```sh
brew install colima docker
colima start --cpu 2 --memory 2 --disk 20 --vm-type vz
pnpm mysql:up        # MySQL 8.4.9 on port 3307 (root / dev), container "ticketsmith-mysql"
```

Use the same version as the project's databases (`SELECT VERSION();`); Change the image tag in the `mysql:up` script and in CI if a project needs another one.

## Daily use

```sh
colima start && pnpm mysql:up   # when you need it
pnpm test:integration           # against the local MySQL
pnpm mysql:down && colima stop  # when done; nothing keeps running
```

The tests create and drop their own schema (`ticketsmith_it`) and a read-only user; they never touch other schemas. CI runs them against a MySQL service container.

## What they prove

- Guarded reads work on real SQL (joins, CTEs, JSON) and truncation is reported.
- **Defense in depth:** forged writes that skip the guard (`UPDATE`, `INSERT`, `DELETE`, `CREATE`, `DROP`, `TRUNCATE`, `ALTER`) are refused by MySQL itself, a forged `SET transaction_read_only = OFF` does not survive into the next call, batches are refused by the server, and no data changes.
- Introspection, grant detection (write-capable vs read-only account), time limits and unreachable servers.
