import { Command } from 'commander'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { defaultProjectJql, TicketKeySchema } from '../../core/tickets/index.ts'
import { nextUnprocessed, processTicket } from './run-ticket.ts'

type ProcessFlags = {
  readonly next: boolean
  readonly playbook: string
  readonly model?: string
  readonly budget?: number
}

const parseBudget = (value: string): number => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
    fail(`Invalid --budget "${value}": a number of US dollars between 0 and 100.`)
  }
  return amount
}

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const processCommand = ({ io, servicesFor, startAgentToolServer }: CommandDeps): Command =>
  new Command('process')
    .description('Investigate a ticket with the agent and write analysis.md and jira_comment.md')
    .argument('[key]', 'ticket key, e.g. OPS-123')
    .option('--next', "the first ticket of the project's JQL without an analysis yet", false)
    .option('--playbook <name>', 'playbook: knowledge/playbooks/<name>.md or built-in', 'bug')
    .option('--model <model>', 'Claude model (default: agent.model or your Claude Code default)')
    .option('--budget <usd>', 'maximum spend for this run, in US dollars', parseBudget)
    .action(async (rawKey: string | undefined, flags: ProcessFlags, command: Command) => {
      if ((rawKey === undefined) === !flags.next) fail('Give a ticket key or --next (not both).')
      const global = globalOptions(command)
      const services = servicesFor(command)
      const opened = await openProject(services, global.project)
      const tickets = await requireTickets(services, opened)

      let key = rawKey?.trim().toUpperCase()
      if (flags.next) {
        const jql =
          tickets.config.jql ??
          (tickets.config.projectKey === undefined
            ? fail('No JQL for --next: run `ticketsmith jira discover` first.')
            : defaultProjectJql(tickets.config.projectKey))
        const next = orFail(await nextUnprocessed(tickets, jql, opened.paths.outDir), String)
        if (next === null) {
          io.out('Every ticket of the project JQL already has an analysis.\n')
          return
        }
        key = next
      }
      const parsed = TicketKeySchema.safeParse(key)
      if (!parsed.success) fail(`Invalid ticket key "${rawKey}". Expected PROJECT-123.`)

      const budget = flags.budget ?? opened.project.agent.maxBudgetUsd
      io.err(
        `Investigating ${parsed.data} with Claude (playbook ${flags.playbook}, budget $${budget.toFixed(2)}, up to ${opened.project.agent.timeoutMinutes} min)…\n`,
      )
      const result = orFail(
        await processTicket(
          services,
          opened,
          tickets,
          parsed.data,
          { playbook: flags.playbook, model: flags.model, budgetUsd: flags.budget },
          () => startAgentToolServer(command, { auditCommand: 'process' }),
        ),
        String,
      )
      if (global.json) {
        io.out(`${JSON.stringify(result.record, null, 2)}\n`)
        return
      }
      const { analysis, record, dir } = result
      io.out(
        [
          `${record.ticket}: ${analysis.summary}`,
          '',
          `Probable cause (${analysis.confidence} confidence): ${analysis.probableCause}`,
          '',
          `Analysis:      ${dir}/analysis.md`,
          `JIRA comment:  ${dir}/jira_comment.md (review it, then paste it yourself)`,
          `Run:           $${record.costUsd.toFixed(2)} · ${record.turns} turns · ${duration(record.durationMs)}`,
          ...(record.changeRequests.length === 0
            ? []
            : [
                '',
                'Database changes waiting for your approval (nothing ran yet):',
                ...record.changeRequests.map(
                  (id) =>
                    `  ticketsmith changes show ${id}   then   ticketsmith changes approve ${id}`,
                ),
              ]),
          '',
        ].join('\n'),
      )
    })
