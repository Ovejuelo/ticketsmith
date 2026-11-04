# 0032. Saving knowledge from Claude Code: `knowledge_save`, interactive sessions only

- **Status:** accepted (2026-11-02)

## Context
Used straight from Claude Code (`ticketsmith mcp`, the plugin), Ticketsmith could only read knowledge. Cases were saved by `knowledge add <KEY>` or at the end of `process`/`code`/`feature`, and `buildCase` needs the `out/<KEY>/` files that an interactive session never writes. People ended up telling Claude a file path by hand, which skipped masking and the folder rules.

## Decision
- A new MCP tool, `knowledge_save`, in `features/knowledge/`: kind `case` writes `knowledge/cases/<KEY>.md` (front matter like `buildCase`, `savedBy: claude-code`), kind `note` writes `knowledge/notes/<slug>.md`.
- **Only those two folders.** The brief, playbooks, `ticket-types.md`, repository maps and schemas are generated or read as instructions by later runs. If the agent could write them, a prompt injection in a ticket would become a persistent one.
- **Never overwrite:** an existing file gets a dated `## Update` section appended, so a case a person saved can't be lost.
- **Masked and confined:** written through `writeKnowledge`, which masks with the project's rules. Placeholders stay as they are (knowledge is shared, so it is never revealed). A folder or file that resolves through symlinks outside `knowledge/` is refused.
- **Interactive sessions only:** `ToolContext.knowledge.writable` (carrying the project's masking rules) is set only by the stdio `mcp` session. Agent runs (`process`, `code`, `feature`, `investigate`, `classify`, `eval`, `refresh`) never register the tool, so saving there stays a person's decision at the end of the command.
- **Offering to save:** the `investigate-ticket` skill asks Claude to offer saving at the end, but skills load only when the model picks them, and in practice it didn't. So a tool can add an `instruction` to the MCP server's instructions, which the client sends in every session. `knowledge_save` adds one asking Claude to offer saving at the end; it only appears where the tool is registered.
- **Audit:** the server now masks every tool's input before auditing it (the agent may type a real value in JQL or SQL). A tool can also summarize its input with `auditInput`; `knowledge_save` records its content by length only.

## Consequences
Cases from Claude Code sessions and findings without a ticket (the gap left by ADR 0031) reach `knowledge_search` without manual paths. A Claude Code permission prompt is the only check before writing, which is acceptable because this is a local, masked file that reaches the team only when a person commits the project folder. Still, an injected ticket could get misleading text into `cases/` or `notes/`, so those changes are worth reading in the project repo's diff.
