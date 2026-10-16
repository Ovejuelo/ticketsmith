import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/core/kernel/index.ts'
import { apiBaseUrl } from '#src/core/tickets/providers/jira-cloud/api-base-url.ts'
import { JiraCloudTicketSource } from '#src/core/tickets/providers/jira-cloud/jira-cloud-ticket-source.ts'
import { JiraHttpClient } from '#src/core/tickets/providers/jira-cloud/jira-http-client.ts'
import { TicketKeySchema } from '#src/core/tickets/ticket.schema.ts'
import { jiraFixtures } from '#tests/fixtures/jira/index.ts'
import { FakeFetch, instantSleep } from '#tests/support/fake-fetch.ts'

const siteUrl = 'https://example.atlassian.net'

const sourceWith = (fake: FakeFetch, customFields: Record<string, string> = {}) =>
  new JiraCloudTicketSource(
    new JiraHttpClient({
      baseUrl: apiBaseUrl({ kind: 'scoped', cloudId: 'cloud-1' }),
      email: 'me@acme.test',
      token: 't',
      logger: createLogger({ level: 'silent' }),
      fetch: fake.fetch,
      sleep: instantSleep,
    }),
    { siteUrl, customFields },
  )

const key = TicketKeySchema.parse('OPS-42')

describe('JiraCloudTicketSource', () => {
  it('verifies the connection through the scoped gateway', async () => {
    const fake = new FakeFetch().on('/rest/api/3/myself', {
      body: { accountId: 'acc-9', displayName: 'Me', emailAddress: 'me@acme.test' },
    })

    expect(await sourceWith(fake).verifyConnection()).toEqual({
      ok: true,
      value: { accountId: 'acc-9', displayName: 'Me', siteUrl },
    })
    expect(fake.requests[0]?.url.origin).toBe('https://api.atlassian.com')
    expect(fake.pathsRequested()).toEqual(['/ex/jira/cloud-1/rest/api/3/myself'])
  })

  it('fetches the issue with mapped custom fields and all comment pages', async () => {
    const page = (startAt: number, ids: string[]) => ({
      body: {
        startAt,
        total: 3,
        comments: ids.map((id) => ({ id, created: '2026-10-02T10:00:00.000+0000', body: null })),
      },
    })
    const fake = new FakeFetch()
      .on('/issue/OPS-42', { body: jiraFixtures.issue() })
      .on('/issue/OPS-42/comment', page(0, ['1', '2']), page(2, ['3']))

    const result = await sourceWith(fake, { module: 'customfield_10042' }).getTicket(key)

    expect(result.ok && result.value.comments.map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(result.ok && result.value.customFields).toEqual({ module: 'Billing' })
    const issueRequest = fake.requests[0]
    expect(issueRequest?.url.searchParams.get('fields')).toContain('customfield_10042')
    expect(fake.requests.slice(1).map((r) => r.url.searchParams.get('startAt'))).toEqual(['0', '2'])
  })

  it('reports a missing issue with its key', async () => {
    const fake = new FakeFetch().on('/issue/OPS-42', {
      status: 404,
      body: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
    })
    expect(await sourceWith(fake).getTicket(key)).toEqual({
      ok: false,
      error: { kind: 'not-found', key: 'OPS-42' },
    })
  })

  it('searches with JQL and returns the next page token', async () => {
    const fake = new FakeFetch().on('/rest/api/3/search/jql', { body: jiraFixtures.searchJql() })

    const result = await sourceWith(fake).search({
      query: 'project = OPS',
      limit: 500,
      pageToken: 'p1',
    })

    expect(result.ok && result.value.tickets.map((t) => [t.key, t.priority, t.assignee])).toEqual([
      ['OPS-42', 'High', { id: 'acc-2', displayName: 'Ben Engineer' }],
      ['OPS-44', null, null],
    ])
    expect(result.ok && result.value.nextPageToken).toBe('token-page-2')
    const params = fake.requests[0]?.url.searchParams
    expect(params?.get('jql')).toBe('project = OPS')
    expect(params?.get('maxResults')).toBe('100')
    expect(params?.get('nextPageToken')).toBe('p1')
  })
})
