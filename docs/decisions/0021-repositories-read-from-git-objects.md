# 0021. Repositories: dedicated clones, reads from git objects, deterministic maps

- **Status:** accepted (2026-10-16)

## Context
Phase 5 lets Claude read the code of a project's repositories (any number, any host) to explain bugs with `file:line` evidence. The clones must never be the user's working copies, git credentials must stay with the user, and nothing the repository ignores (`.env`, local config) may reach the model. The map the agent reads first could be written by the agent itself, but the agent runtime arrives in phase 6.

## Decision
- **Dedicated clones** in `<project>/local/repos/<name>`, kept detached at the fix branch (`fetch --prune` + `checkout --detach origin/<fix>`). Cloning and fetching use the user's SSH agent or credential helper with prompts disabled (`GIT_TERMINAL_PROMPT=0`), so the MCP server never hangs. URLs with embedded credentials are rejected by the config schema.
- **One module runs git** (`core/repos/git.ts`): `execFile` without a shell, timeouts, refs and paths validated (no leading `-`, no `..`, no pathspec magic), options ended with `--`/`--end-of-options`.
- **Reads come from git objects, never the file system:** `git ls-tree`, `git grep <commit>` and `git cat-file blob <commit>:<path>`. Only tracked content at a resolved commit is visible: ignored files, `.git/` and anything a symlink points to cannot be read. MCP tools `repo_list`, `repo_files`, `repo_search` and `repo_read` build on this, and their output is masked and audited like every tool.
- **Deterministic maps** (`features/projects/repo-map.ts`): stack, structure, entry points, endpoints, screens, outgoing calls, models, migrations, SQL, config files and tests, from the file list, a few manifests and `git grep` prefilters; detection lives in data tables, nothing product-specific. The map is stored in the catalog and regenerated only when the commit moves; `knowledge/repos/_connections.md` matches calls to routes across repositories. Phase 6 adds an agent-written analysis on top.
- **No port for git:** it is a local binary with one implementation; tests use real repositories in temp folders with `file://` remotes.

## Consequences
Investigations cite real code without Claude Code permission prompts or access outside the clones. Uncommitted or ignored content is invisible by design, so a repository's secrets live only where git ignores them; tracked secrets are still masked. Heuristic maps can miss frameworks or mounts; they say so, and the tools let the agent verify. Email masking learned that `git@host:org/repo` is a remote, not an address.
