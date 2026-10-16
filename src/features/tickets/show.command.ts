import { Command } from 'commander'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../../core/output/index.ts'
import { maskSensitiveData } from '../../core/security/index.ts'
import {
  describeTicketSourceError,
  renderTicketMarkdown,
  TicketKeySchema,
} from '../../core/tickets/index.ts'

export const showCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('show')
    .description('Print a ticket as Markdown (or JSON with --json)')
    .argument('<key>', 'ticket key, e.g. OPS-123')
    .option('--out', "also save ticket.md and ticket.json to the project's output folder", false)
    .option('--mask', 'mask sensitive data, e.g. before piping to an LLM', false)
    .action(async (rawKey: string, options: { out: boolean; mask: boolean }, command: Command) => {
      const parsedKey = TicketKeySchema.safeParse(rawKey.trim().toUpperCase())
      if (!parsedKey.success) fail(`Invalid ticket key "${rawKey}". Expected PROJECT-123.`)

      const global = globalOptions(command)
      const services = servicesFor(command)
      const opened = await openProject(services, global.project)
      const { project, paths } = opened
      const tickets = await requireTickets(services, opened)
      const ticket = orFail(
        await tickets.source.getTicket(parsedKey.data),
        describeTicketSourceError,
      )

      const counts: Record<string, number> = {}
      const maybeMask = (text: string): string => {
        if (!options.mask) return text
        const masked = maskSensitiveData(text, project.masking)
        for (const [kind, count] of Object.entries(masked.counts)) {
          counts[kind] = Math.max(counts[kind] ?? 0, count)
        }
        return masked.text
      }
      const markdown = maybeMask(renderTicketMarkdown(ticket))
      const json = maybeMask(`${JSON.stringify(ticket, null, 2)}\n`)
      io.out(global.json ? json : markdown)
      if (options.mask) {
        const summary = Object.entries(counts).map(([kind, count]) => `${kind} ${count}`)
        io.err(`Masked: ${summary.length > 0 ? summary.join(', ') : 'nothing'}\n`)
      }

      if (options.out) {
        const dir = ticketOutputDir(paths.outDir, ticket.key)
        orFail(
          await writeOutputFiles(dir, { 'ticket.md': markdown, 'ticket.json': json }),
          describeOutputError,
        )
        io.err(`Saved to ${dir}\n`)
      }
    })
