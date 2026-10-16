import { Command } from 'commander'
import { type CommandDeps, fail, globalOptions, openProject, orFail } from '../../core/cli/index.ts'
import { saveCase } from '../../core/knowledge/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'

export const knowledgeCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('knowledge').description("The project's knowledge for the agent").addCommand(
    new Command('add')
      .description('Save a resolved ticket as a case in knowledge/cases (masked)')
      .argument('<key>', 'ticket key, e.g. OPS-123')
      .option('--note <text>', 'how it was resolved, in one or two sentences')
      .action(async (raw: string, options: { note?: string }, command: Command) => {
        const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
        if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
        const { project, paths } = await openProject(
          servicesFor(command),
          globalOptions(command).project,
        )
        const file = orFail(
          await saveCase(
            paths.knowledgeDir,
            paths.outDir,
            parsed.data,
            options.note,
            project.masking,
          ),
          String,
        )
        io.out(`Saved knowledge/${file}. The agent finds it with knowledge_search.\n`)
      }),
  )
