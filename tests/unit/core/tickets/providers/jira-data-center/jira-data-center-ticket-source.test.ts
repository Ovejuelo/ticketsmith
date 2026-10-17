import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/core/kernel/index.ts'
import { JiraHttpClient } from '#src/core/tickets/providers/jira-cloud/jira-http-client.ts'
import {
  JiraDataCenterDiscovery,
  JiraDataCenterTicketSource,
  JiraDataCenterTicketWriter,
} from '#src/core/tickets/providers/jira-data-center/index.ts'
import { TicketKeySchema } from '#src/core/tickets/ticket.schema.ts'
import { jiraDataCenterFixtures } from '#tests/fixtures/jira-data-center/index.ts'
import { FakeFetch, instantSleep } from '#tests/support/fake-fetch.ts'

const siteUrl = 'https://jira.example.com/jira'

const clientWith = (fake: FakeFetch) =>
  new JiraHttpClient({
    baseUrl: siteUrl,
    token: 'pat-1',
    logger: createLogger({ level: 'silent' }),
    fetch: fake.fetch,
    sleep: instantSleep,
  })
const sourceWith = (fake: FakeFetch, customFields: Record<string, string> = {}) =>
  new JiraDataCenterTicketSource(clientWith(fake), { siteUrl, customFields })

const key = TicketKeySchema.parse('OPS-42')

describe('JiraDataCenterTicketSource', () => {
  it('verifies the connection with the personal access token as a Bearer token', async () => {
    const fake = new FakeFetch().on('/rest/api/2/myself', {
      body: { key: 'JIRAUSER10300', name: 'me', displayName: 'Me' },
    })
    expect(await sourceWith(fake).verifyConnection()).toEqual({
      ok: true,
      value: { accountId: 'JIRAUSER10300', displayName: 'Me', siteUrl },
    })
    expect(fake.pathsRequested()).toEqual(['/jira/rest/api/2/myself'])
    expect(fake.requests[0]?.headers.get('authorization')).toBe('Bearer pat-1')
  })

  it('normalizes a v2 issue: wiki markup to Markdown, users by key, comments paged', async () => {
    const fake = new FakeFetch()
      .on('/rest/api/2/issue/OPS-42', { body: jiraDataCenterFixtures.issue() })
      .on('/rest/api/2/issue/OPS-42/comment', {
        body: {
          startAt: 0,
          total: 1,
          comments: [
            {
              id: '9',
              author: { key: 'JIRAUSER10200', name: 'ben.engineer', displayName: 'Ben Engineer' },
              body: 'Checked: _not_ a cache issue. See [logs|https://logs.example.com].',
              created: '2026-10-02T10:00:00.000+0000',
            },
          ],
        },
      })

    const result = await sourceWith(fake, { module: 'customfield_10042' }).getTicket(key)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value).toMatchObject({
      key: 'OPS-42',
      url: 'https://jira.example.com/jira/browse/OPS-42',
      type: 'Bug',
      reporter: { id: 'JIRAUSER10100', displayName: 'Ana Reporter' },
      customFields: { module: 'Billing' },
      comments: [
        {
          id: '9',
          author: { id: 'JIRAUSER10200', displayName: 'Ben Engineer' },
          body: 'Checked: *not* a cache issue. See [logs](https://logs.example.com).',
        },
      ],
    })
    expect(result.value.description).toBe(
      [
        'Merchant **123** cannot see invoices since the last deploy.',
        '',
        '1. Log in as the merchant',
        '1. Open `/invoices`',
        '',
        '```json',
        '{"error": "timeout"}',
        '```',
        'Contact: ana@northwind.mx',
      ].join('\n'),
    )
  })

  it('pages search results by startAt, using it as the page token', async () => {
    const fake = new FakeFetch().on('/rest/api/2/search', {
      body: jiraDataCenterFixtures.search(),
    })
    const first = await sourceWith(fake).search({ query: 'project = OPS', limit: 2 })
    expect(first.ok && first.value.tickets.map((t) => t.key)).toEqual(['OPS-42', 'OPS-43'])
    expect(first.ok && first.value.nextPageToken).toBe('2')
    expect(fake.requests[0]?.url.searchParams.get('startAt')).toBe('0')

    await sourceWith(fake).search({ query: 'project = OPS', limit: 2, pageToken: '2' })
    expect(fake.requests[1]?.url.searchParams.get('startAt')).toBe('2')
    expect((await sourceWith(fake).search({ query: 'x', limit: 2, pageToken: 'nope' })).ok).toBe(
      false,
    )
  })
})

describe('JiraDataCenterTicketWriter and discovery', () => {
  it('posts comments as wiki markup through API v2', async () => {
    const fake = new FakeFetch().on('/rest/api/2/issue/OPS-42/comment', {
      status: 201,
      body: { id: '77' },
    })
    const posted = await new JiraDataCenterTicketWriter(clientWith(fake), siteUrl).addComment(
      key,
      '## Cause\n\nThe **card** expired.',
    )
    expect(posted).toEqual({
      ok: true,
      value: { url: 'https://jira.example.com/jira/browse/OPS-42?focusedCommentId=77' },
    })
    expect(fake.requests[0]?.body).toEqual({ body: 'h2. Cause\n\nThe *card* expired.' })
  })

  it('lists projects, fields and board filters through API v2', async () => {
    const fake = new FakeFetch()
      .on('/rest/api/2/project', {
        body: [
          { id: '2', key: 'WEB', name: 'Web' },
          { id: '1', key: 'OPS', name: 'Operations' },
        ],
      })
      .on('/rest/api/2/field', {
        body: [
          { id: 'summary', name: 'Summary', custom: false },
          { id: 'customfield_10042', name: 'Module', custom: true },
        ],
      })
      .on('/rest/agile/1.0/board/5/configuration', { body: { filter: { id: '300' } } })
      .on('/rest/api/2/filter/300', { body: { jql: 'project = OPS' } })
    const discovery = new JiraDataCenterDiscovery(clientWith(fake))
    expect(await discovery.listProjects()).toEqual({
      ok: true,
      value: [
        { key: 'OPS', name: 'Operations' },
        { key: 'WEB', name: 'Web' },
      ],
    })
    expect(await discovery.listCustomFields()).toEqual({
      ok: true,
      value: [{ id: 'customfield_10042', name: 'Module' }],
    })
    expect(await discovery.getBoardFilterJql(5)).toEqual({ ok: true, value: 'project = OPS' })
  })
})
