import { Command } from 'commander'
import {
  CLASSIFY_TOOLS,
  type Classification,
  resolveClassification,
} from '../../core/classification/index.ts'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { describeTicketSourceError, TicketKeySchema } from '../../core/tickets/index.ts'

/** What to run next for a classified ticket. */
export const nextCommand = (key: string, classification: Classification): string => {
  if (classification.route === 'code') return `ticketsmith code ${key}`
  if (classification.route === 'feature') return `ticketsmith feature ${key}`
  return `ticketsmith process ${key}${classification.playbook === null ? '' : ` --playbook ${classification.playbook}`}`
}

export const classifyCommand = ({ io, servicesFor, startAgentToolServer }: CommandDeps): Command =>
  new Command('classify')
    .description('Classify a ticket: rules first, the LLM when unsure, you when both are')
    .argument('<key>', 'ticket key, e.g. OPS-123')
    .option('--no-llm', 'rules only (free); never ask the LLM')
    .action(async (raw: string, flags: { llm: boolean }, command: Command) => {
      const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
      if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
      const global = globalOptions(command)
      const services = servicesFor(command)
      const opened = await openProject(services, global.project)
      const tickets = await requireTickets(services, opened)
      const ticket = orFail(await tickets.source.getTicket(parsed.data), describeTicketSourceError)
      const { classification, costUsd } = orFail(
        await resolveClassification(services, opened, ticket, {
          interactive: io.interactive,
          llm: flags.llm,
          startToolServer: () =>
            startAgentToolServer(command, { auditCommand: 'classify', only: CLASSIFY_TOOLS }),
        }),
        String,
      )
      if (global.json) {
        io.out(`${JSON.stringify({ ticket: ticket.key, ...classification, costUsd }, null, 2)}\n`)
        return
      }
      io.out(
        [
          `${ticket.key}: ${classification.type} (${classification.confidence}, by ${classification.source}${costUsd > 0 ? `, $${costUsd.toFixed(2)}` : ''})`,
          `Why: ${classification.reason}`,
          `Next: ${nextCommand(ticket.key, classification)}`,
          '',
        ].join('\n'),
      )
    })
