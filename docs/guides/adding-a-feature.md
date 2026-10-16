# Adding a feature, command or MCP tool

A **feature** is one user-facing capability (`projects`, `tickets`, `doctor`…). It owns its CLI commands, its MCP tools and the logic only it uses.

## A new feature

1. Create `src/features/<name>/`.
2. Add its commands (`*.command.ts`) and/or tools (`*.tool.ts`), plus plain logic files.
3. Export it from `src/features/<name>/index.ts`:

   ```ts
   import type { Feature } from '../../core/feature/index.ts'
   import { exampleCommand } from './example.command.ts'
   import { exampleTool } from './example.tool.ts'

   /** One line saying what this capability does. */
   export const exampleFeature: Feature = {
     name: 'example',
     commands: [exampleCommand],
     tools: [exampleTool],
   }
   ```

4. Add it to `FEATURES` in `src/bootstrap/features.ts`.
5. Add tests under `tests/unit/features/<name>/`, mirroring the file names.

If the new feature needs something another feature has, move that code to `core/` instead of importing across features (`pnpm arch` enforces this).

## A CLI command

```ts
// src/features/example/hello.command.ts
import { Command } from 'commander'
import { type CommandDeps, globalOptions, openProject } from '../../core/cli/index.ts'

export const helloCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('hello')
    .description('Say hello with the active project')
    .action(async (_, command: Command) => {
      const { project } = await openProject(servicesFor(command), globalOptions(command).project)
      io.out(`Hello from ${project.name}\n`)
    })
```

- If it needs an integration, connect it with `requireTickets(services, opened)` (or the equivalent for that integration): it explains how to add the integration when it is missing.
- Keep it thin: options in, call logic, print. Logic longer than a few lines goes to a plain file in the feature (e.g. `say-hello.ts`).
- Print with `io.out` / `io.err` (testable), never `console.log`.
- Turn expected errors into messages with `orFail(result, describeX)`; `fail(message)` for user errors.
- Support `--json` when the output is data.
- Test it with `FakeCli` (`tests/support/fake-cli.ts`): `await cli.run('hello')`, then assert on `cli.stdout`.

## An MCP tool

```ts
// src/features/example/hello.tool.ts
import { z } from 'zod'
import { ok } from '../../core/kernel/index.ts'
import { defineTool } from '../../core/mcp/index.ts'

export const helloTool = defineTool({
  name: 'example_hello',
  title: 'Say hello',
  description: 'What it does, written for the model: when to use it and what it returns.',
  inputSchema: { name: z.string().describe('Who to greet') },
  requires: [], // integrations this tool needs, e.g. ['tickets']; it is hidden otherwise
  readOnly: true,
  run: async ({ name }) => ok(`Hello ${name}`),
})
```

- Return `Result<string, string>`: text for the model, or an error message it can act on.
- Do **not** mask, audit or catch exceptions: `bootstrap/mcp-server.ts` wraps every tool with masking, auditing and error handling.
- If an input may contain placeholders (`[EMAIL_1]`), call `context.resolvePlaceholders(text)` before using it and fail with `unknownPlaceholdersMessage` on unknown ones.
- Tools with side effects are `readOnly: false` and must follow the approval flow (requirements §4.9–4.10).
- Test it through `createMcpServer` with an in-memory client (see `tests/unit/bootstrap/mcp-server.test.ts`).
