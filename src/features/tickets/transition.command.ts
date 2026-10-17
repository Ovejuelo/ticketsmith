import { Command } from 'commander'
import {
  askChoice,
  askConfirm,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import {
  applyTransition,
  findTransition,
  suggestedTransition,
  WRITES_OFF,
} from '../../core/publishing/index.ts'
import { describeTicketSourceError, TicketKeySchema } from '../../core/tickets/index.ts'

export const transitionCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('transition')
    .description(
      "Move a ticket to another status (the analysis' suggestion by default) after you confirm",
    )
    .argument('<key>', 'ticket key, e.g. OPS-123')
    .argument('[status]', 'transition or target status name')
    .action(async (raw: string, status: string | undefined, _, command: Command) => {
      const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
      if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
      if (!io.interactive) fail('Transitions need an interactive terminal: you confirm each one.')
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      const tickets = await requireTickets(services, opened)
      if (tickets.writer === null) fail(WRITES_OFF)
      const available = orFail(
        await tickets.writer.transitions(parsed.data),
        describeTicketSourceError,
      )
      if (available.length === 0) fail(`${parsed.data} has no transitions available to you.`)
      const wanted = status ?? (await suggestedTransition(opened.paths.outDir, parsed.data))
      let chosen = wanted === null ? undefined : findTransition(available, wanted)
      if (wanted !== null && chosen === undefined && status !== undefined) {
        fail(
          `No transition "${status}" for ${parsed.data}. Available: ${available.map((t) => `${t.name} (→ ${t.to})`).join(', ')}.`,
        )
      }
      if (chosen === undefined) {
        const id = await askChoice(
          `Move ${parsed.data} to:`,
          available.map((t) => ({ value: t.id, label: `${t.name} (→ ${t.to})` })),
        )
        chosen = available.find((t) => t.id === id)
      }
      if (chosen === undefined) fail('No transition chosen.')
      const moved = orFail(
        await applyTransition(
          tickets.writer,
          services.openAuditLog(opened.project.name, opened.paths, 'tickets'),
          parsed.data,
          chosen,
          { show: (t) => io.out(t), ask: (q) => askConfirm(q, false) },
        ),
        String,
      )
      io.out(moved ? `${parsed.data} moved to ${chosen.to}.\n` : 'Nothing changed.\n')
    })
