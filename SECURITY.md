# Security

Ticketsmith hands company tickets, data and code to an AI agent. Its first design goal is to be **secure by construction**: dangerous capabilities do not exist as code, so safety never depends on the model behaving. See [requirements §2](docs/requirements.md) for the principles.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: *Security* tab → *Report a vulnerability*. Include what you found, how to reproduce it and the version (`ticketsmith --version`). We aim to answer within a week and to credit you in the release notes, unless you prefer otherwise.

## Threat model

**What the agent can reach.** Only the Ticketsmith MCP tools, served by the Ticketsmith process:
- tickets, masked;
- guarded `SELECT`s, masked;
- tracked repository content from git objects, never ignored files such as `.env`;
- the project's knowledge.

For code changes it gets file tools confined to the ticket worktrees, and it never gets a shell.

**What it can never do.**
- It holds no credentials and no raw database connection: passwords and tokens are read from the keychain by the Ticketsmith process only.
- It cannot run SQL that writes. A proposal is executed only after a person types the database name in a terminal (ADR 0023), and DELETE and DDL are rejected outright.
- It cannot post to JIRA, push, open pull requests or create Metabase questions. A person does all of these from the CLI after reading the exact content.

**Defense in depth for reads:**
- **Text layer:** a fail-closed check of the SQL text for tricks the parser cannot see.
- **Tree layer:** the parsed tree is validated, and what runs is the SQL regenerated from it (ADR 0019, ADR 0028).
- **Session:** a read-only session and transaction, a time limit and an unconditional `ROLLBACK`.

**Masking.** Sensitive values (emails, phones, tax ids, bank accounts, cards, secrets) are replaced inside the tools, with placeholders kept consistent for the session. Masking favors precision, so it can miss unusual formats. Repository code reaches the model unmasked.

**Prompt injection.** Ticket text, data and code are untrusted input that may contain instructions for the agent. Ticketsmith does not try to detect them. It limits what any instruction could achieve: only read-only tools, and every side effect needs a person. Review the agent's outputs (`analysis.md`, comments, diffs, proposed SQL) before acting on them.

**Out of scope:** the security of your JIRA, databases, git hosts and Anthropic account; a compromised local machine; and a person approving something they did not read.

## Supported versions

Only the latest release gets fixes. Users get it through `npx ticketsmith@latest` (the plugin) or the CLI's update notice.
