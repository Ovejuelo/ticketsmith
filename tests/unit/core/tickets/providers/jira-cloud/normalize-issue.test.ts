import { describe, expect, it } from 'vitest'
import {
  JiraCommentPageSchema,
  JiraIssueSchema,
} from '#src/core/tickets/providers/jira-cloud/jira-api.schemas.ts'
import {
  flattenFieldValue,
  normalizeIssue,
  toIsoUtc,
} from '#src/core/tickets/providers/jira-cloud/normalize-issue.ts'
import { jiraFixtures } from '#tests/fixtures/jira/index.ts'

const issue = JiraIssueSchema.parse(jiraFixtures.issue())
const { comments } = JiraCommentPageSchema.parse(jiraFixtures.comments())
const context = {
  siteUrl: 'https://example.atlassian.net',
  customFields: {
    module: 'customfield_10042',
    environment: 'customfield_10050',
    empty: 'customfield_10060',
    missing: 'customfield_99999',
  },
}

describe('normalizeIssue', () => {
  const result = normalizeIssue(issue, comments, context)
  if (!result.ok) throw new Error(result.error)
  const ticket = result.value

  it('maps core fields and converts dates to UTC', () => {
    expect(ticket).toMatchObject({
      key: 'OPS-42',
      url: 'https://example.atlassian.net/browse/OPS-42',
      type: 'Bug',
      status: 'In Progress',
      priority: 'High',
      labels: ['billing', 'customer-reported'],
      components: ['Invoices'],
      reporter: { id: 'acc-1', displayName: 'Ana Reporter' },
      assignee: { id: 'acc-2', displayName: 'Ben Engineer' },
      created: '2026-10-01T14:15:00.000Z',
      updated: '2026-10-14T18:30:12.345Z',
    })
  })

  it('converts the ADF description and comments to Markdown', () => {
    expect(ticket.description).toBe(
      [
        'Merchant **123** cannot see invoices since the last deploy.',
        '1. Log in as the merchant\n2. Open Invoices',
        "```text\nTypeError: cannot read properties of undefined (reading 'total')\n```",
        '[attachment: screenshot.png]',
      ].join('\n\n'),
    )
    expect(ticket.comments).toEqual([
      {
        id: '50001',
        author: { id: 'acc-2', displayName: 'Ben Engineer' },
        created: '2026-10-02T15:00:00.000Z',
        body: '@Ana Reporter looking into it.',
      },
    ])
  })

  it('maps links from both directions and attachment metadata', () => {
    expect(ticket.links).toEqual([
      { type: 'blocks', key: 'OPS-43', summary: 'Monthly report' },
      { type: 'relates to', key: 'WEB-7', summary: 'Invoices page refactor' },
    ])
    expect(ticket.attachments).toEqual([
      {
        id: '20001',
        filename: 'screenshot.png',
        mimeType: 'image/png',
        size: 245760,
        created: '2026-10-01T14:16:00.000Z',
      },
    ])
  })

  it('keeps only mapped, non-empty custom fields under their alias', () => {
    expect(ticket.customFields).toEqual({ module: 'Billing', environment: 'Production, Sandbox' })
  })
})

describe('toIsoUtc', () => {
  it('handles offsets without a colon and leaves garbage untouched', () => {
    expect(toIsoUtc('2026-10-15T10:00:00.000+0530')).toBe('2026-10-15T04:30:00.000Z')
    expect(toIsoUtc('not a date')).toBe('not a date')
  })
})

describe('flattenFieldValue', () => {
  it.each([
    [null, ''],
    [3, '3'],
    [{ value: 'Parent', child: { value: 'Child' } }, 'Parent / Child'],
    [{ accountId: 'a', displayName: 'Jane' }, 'Jane'],
    [[{ name: 'v1.0' }, { name: 'v1.1' }], 'v1.0, v1.1'],
    [
      {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich' }] }],
      },
      'rich',
    ],
    [{ weird: true }, '{"weird":true}'],
  ])('flattens %j', (value, expected) => {
    expect(flattenFieldValue(value)).toBe(expected)
  })
})
