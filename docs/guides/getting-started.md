# Getting started on a new machine

From zero to "Claude, investigate OPS-123" on a Mac (Apple silicon or Intel). Linux works the same way, with your distribution's package manager.

## 1. Prerequisites

```sh
brew install fnm
fnm install 24 && fnm default 24     # Node 24 or later
npm install -g @anthropic-ai/claude-code && claude   # log in once
```

If your databases sit behind a VPN or a tunnel, connect it before steps 3 and 5.

## 2. Install Ticketsmith

```sh
npm install -g ticketsmith
ticketsmith --version
```

## 3. Set up your project

```sh
ticketsmith project init
```

The wizard is resumable: stop at any point and run it again. For each integration you pick, it asks for the settings, checks them, then investigates and writes what it learned to the project's `knowledge/`.

- **Ticket source (JIRA Cloud):** your site (`https://<site>.atlassian.net`), your email and a scoped, read-only API token (see the README, "JIRA token"). Then pick the JIRA project or board.
- **Databases:** add one entry per database (name, host, port, database, user; the password goes to the keychain). Put the databases that share a schema in one group, e.g. `shard1` … `shard7` in a group `shards`.
- **Repositories:** the clone URL of each repository (ssh or https), its base branches for fixes and features and its protected branches. Git uses your own access: check it first with `git ls-remote <url>` (SSH key loaded with `ssh-add`, or a credential helper for https).

If the project already exists in a team repository, link it instead and add only your credentials:

```sh
git clone <project repo url> ~/work/ticketsmith-<project>
ticketsmith project link ~/work/ticketsmith-<project>
ticketsmith project add tickets          # and/or: project add databases
ticketsmith project refresh repos        # clones the project's repositories on this machine
```

## 4. Check it

```sh
ticketsmith doctor                       # every configured integration, one line each
ticketsmith list --limit 5
ticketsmith db ask "SELECT 1" --db <name>
```

`doctor` names any database it cannot reach (is the VPN or tunnel up?) and reminds you when an account can write.

## 5. Add the Claude Code plugin

```sh
claude plugin marketplace add Ovejuelo/ticketsmith
claude plugin install ticketsmith@ticketsmith
```

Open Claude Code, run `/mcp` and confirm that `ticketsmith` is connected, then ask:

- "Investigate OPS-123."
- "Which database holds the account of the customer in OPS-123?"
- "What are the open incidents this week?"

Or let Ticketsmith drive the agent itself, from the terminal:

```sh
ticketsmith process OPS-123          # writes out/OPS-123/analysis.md and jira_comment.md
ticketsmith project refresh repos --deep   # once: the agent studies each repository
ticketsmith code OPS-123             # fixes it in a worktree; asks before pushing and opening the PR
```

The MCP server serves the **active project** (`ticketsmith project use <name>` changes it).

## Staying up to date

- **MCP server:** the plugin runs `npx -y ticketsmith@latest mcp`, so every new Claude Code session uses the latest release.
- **CLI:** `npm i -g ticketsmith`. The CLI tells you, at most once a day, when a new release is out.
- **Skills:** `claude plugin update ticketsmith@ticketsmith`, or enable auto-update for the marketplace in `/plugin`.

## Troubleshooting

- **`npx` is slow the first time:** it downloads the package once and caches it.
- **Two `ticketsmith` servers in `/mcp`:** you also registered one by hand (`claude mcp add`). Remove one of them: `claude mcp remove ticketsmith`.
- **Keychain prompts on macOS:** allow access for `node`; Ticketsmith reads only its own entries (`ticketsmith/<project>/…`).
