import { describe, expect, it } from 'vitest'
import { renderTicketMarkdown } from '#src/core/tickets/render-ticket-markdown.ts'
import { type Ticket, TicketSchema } from '#src/core/tickets/ticket.schema.ts'

const ticket: Ticket = TicketSchema.parse({
  key: 'OPS-42',
  url: 'https://example.atlassian.net/browse/OPS-42',
  type: 'Bug',
  status: 'In Progress',
  priority: null,
  summary: 'Invoices missing',
  assignee: null,
  updated: '2026-10-14T18:30:12.345Z',
  description: 'It broke.',
  labels: ['billing'],
  components: [],
  reporter: { id: 'a', displayName: 'Ana' },
  created: '2026-10-01T14:15:00.000Z',
  comments: [{ id: '1', author: null, created: '2026-10-02T15:00:00.000Z', body: 'On it.' }],
  attachments: [
    {
      id: '9',
      filename: 'log.txt',
      mimeType: 'text/plain',
      size: 2048,
      created: '2026-10-01T14:15:00.000Z',
    },
  ],
  links: [{ type: 'blocks', key: 'OPS-43', summary: 'Report' }],
  customFields: { module: 'Billing' },
})

describe('renderTicketMarkdown', () => {
  it('renders a complete document', () => {
    expect(renderTicketMarkdown(ticket)).toBe(`# OPS-42: Invoices missing

- **Type:** Bug
- **Status:** In Progress
- **Priority:** None
- **Assignee:** Unassigned
- **Reporter:** Ana
- **Created:** 2026-10-01T14:15:00.000Z
- **Updated:** 2026-10-14T18:30:12.345Z
- **URL:** https://example.atlassian.net/browse/OPS-42
- **Labels:** billing
- **module:** Billing

## Description

It broke.

## Links

- blocks OPS-43: Report

## Attachments

- log.txt (text/plain, 2.0 KB)

## Comments (1)

### Unknown · 2026-10-02T15:00:00.000Z

On it.
`)
  })
})
