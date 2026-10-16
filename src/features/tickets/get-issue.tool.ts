import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool, ticketsContext } from '../../core/mcp/index.ts'
import {
  describeTicketSourceError,
  renderTicketMarkdown,
  TicketKeySchema,
} from '../../core/tickets/index.ts'

export const getIssueTool = defineTool({
  name: 'jira_get_issue',
  title: 'Get JIRA issue',
  description:
    'Fetch one JIRA ticket as Markdown: metadata, description, links, attachments and all comments.',
  inputSchema: { key: z.string().describe('Ticket key, e.g. OPS-2403') },
  requires: ['tickets'],
  readOnly: true,
  run: async ({ key }, context) => {
    const tickets = ticketsContext(context)
    if (!tickets.ok) return tickets
    const parsed = TicketKeySchema.safeParse(key.trim().toUpperCase())
    if (!parsed.success) return err(`Invalid ticket key "${key}". Expected PROJECT-123.`)
    const ticket = await tickets.value.source.getTicket(parsed.data)
    return ticket.ok
      ? ok(renderTicketMarkdown(ticket.value))
      : err(describeTicketSourceError(ticket.error))
  },
})
