import { Command } from 'commander'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  parsePositiveInt,
  requireTickets,
} from '../../core/cli/index.ts'
import {
  defaultProjectJql,
  describeTicketSourceError,
  type TicketPage,
  type TicketSummary,
} from '../../core/tickets/index.ts'
import { formatTicketTable } from './ticket-table.ts'

export const listCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('list')
    .description("List tickets from the project's JQL")
    .option('-n, --limit <count>', 'maximum number of tickets', parsePositiveInt, 20)
    .option('--jql <query>', "use this JQL instead of the project's")
    .action(async (options: { limit: number; jql?: string }, command: Command) => {
      const global = globalOptions(command)
      const services = servicesFor(command)
      const connection = await requireTickets(services, await openProject(services, global.project))
      const { jql: savedJql, projectKey } = connection.config
      const query =
        options.jql ??
        savedJql ??
        (projectKey === undefined
          ? fail('No JQL configured. Run `ticketsmith jira discover` or pass --jql.')
          : defaultProjectJql(projectKey))

      const tickets: TicketSummary[] = []
      let pageToken: string | null = null
      do {
        const page: TicketPage = orFail(
          await connection.source.search({
            query,
            limit: options.limit - tickets.length,
            ...(pageToken === null ? {} : { pageToken }),
          }),
          describeTicketSourceError,
        )
        tickets.push(...page.tickets)
        pageToken = page.nextPageToken
      } while (pageToken !== null && tickets.length < options.limit)

      const shown = tickets.slice(0, options.limit)
      if (global.json) {
        io.out(`${JSON.stringify(shown, null, 2)}\n`)
      } else if (shown.length === 0) {
        io.out('No tickets match the JQL.\n')
      } else {
        io.out(`${formatTicketTable(shown, io.columns)}\n`)
      }
    })
