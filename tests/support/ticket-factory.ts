import { type Ticket, TicketSchema } from '#src/core/tickets/index.ts'

export const makeTicket = (
  key: string,
  overrides: Partial<Record<keyof Ticket, unknown>> = {},
): Ticket =>
  TicketSchema.parse({
    key,
    url: `https://example.atlassian.net/browse/${key}`,
    type: 'Bug',
    status: 'To Do',
    priority: 'High',
    summary: `Summary of ${key}`,
    assignee: null,
    updated: '2026-10-14T18:30:12.345Z',
    description: 'Something broke.',
    labels: [],
    components: [],
    reporter: null,
    created: '2026-10-01T14:15:00.000Z',
    comments: [],
    attachments: [],
    links: [],
    customFields: {},
    ...overrides,
  })
