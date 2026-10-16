import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool, ticketsContext, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import { describeTicketSourceError, type TicketSummary } from '../../core/tickets/index.ts'

const MAX_LIMIT = 50

export const searchTool = defineTool({
  name: 'jira_search',
  title: 'Search JIRA issues',
  description:
    'Search tickets with JQL and return a summary list (key, type, status, priority, assignee, summary). Without "jql" it uses the profile\'s default query (open tickets by priority). Use jira_get_issue for details.',
  inputSchema: {
    jql: z.string().optional().describe('JQL query; omit to use the profile default'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Maximum tickets to return (default 20, max ${MAX_LIMIT})`),
  },
  requires: ['tickets'],
  readOnly: true,
  run: async ({ jql, limit }, context) => {
    const tickets = ticketsContext(context)
    if (!tickets.ok) return tickets
    const requested = jql?.trim() || tickets.value.defaultJql
    if (requested === undefined) {
      return err(
        'No JQL given and the profile has none. Pass "jql" or run `ticketsmith jira discover`.',
      )
    }
    const query = context.resolvePlaceholders(requested)
    if (!query.ok) return err(unknownPlaceholdersMessage(query.error))

    const page = await tickets.value.source.search({ query: query.value, limit: limit ?? 20 })
    // Echo the JQL as the model wrote it; the resolved one holds real values.
    return page.ok
      ? ok(renderSearchResults(requested, page.value.tickets, page.value.nextPageToken !== null))
      : err(describeTicketSourceError(page.error))
  },
})

const renderSearchResults = (
  jql: string,
  tickets: readonly TicketSummary[],
  hasMore: boolean,
): string => {
  if (tickets.length === 0) return `No tickets match the JQL: ${jql}`
  const lines = tickets.map(
    (t) =>
      `- **${t.key}** · ${t.type} · ${t.status} · ${t.priority ?? 'No priority'} · ${t.assignee?.displayName ?? 'Unassigned'}: ${t.summary}`,
  )
  const more = hasMore ? '\n\nMore tickets match; narrow the JQL or raise the limit.' : ''
  return `${tickets.length} ticket(s) for JQL: ${jql}\n\n${lines.join('\n')}${more}`
}
