import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/core/kernel/index.ts'
import { JiraCloudDiscovery } from '#src/core/tickets/providers/jira-cloud/jira-cloud-discovery.ts'
import { JiraHttpClient } from '#src/core/tickets/providers/jira-cloud/jira-http-client.ts'
import { FakeFetch, instantSleep } from '#tests/support/fake-fetch.ts'

const discoveryWith = (fake: FakeFetch) =>
  new JiraCloudDiscovery(
    new JiraHttpClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'me@acme.test',
      token: 't',
      logger: createLogger({ level: 'silent' }),
      fetch: fake.fetch,
      sleep: instantSleep,
    }),
  )

describe('JiraCloudDiscovery', () => {
  it('pages through projects until the last page', async () => {
    const fake = new FakeFetch().on(
      '/rest/api/3/project/search',
      { body: { values: [{ id: '1', key: 'OPS', name: 'Operations' }], isLast: false } },
      { body: { values: [{ id: '2', key: 'WEB', name: 'Web' }], isLast: true } },
    )

    expect(await discoveryWith(fake).listProjects()).toEqual({
      ok: true,
      value: [
        { key: 'OPS', name: 'Operations' },
        { key: 'WEB', name: 'Web' },
      ],
    })
    expect(fake.requests.map((r) => r.url.searchParams.get('startAt'))).toEqual(['0', '50'])
  })

  it('reads a board with its project', async () => {
    const fake = new FakeFetch().on('/rest/agile/1.0/board/245', {
      body: { id: 245, name: 'Support', type: 'kanban', location: { projectKey: 'OPS' } },
    })
    expect(await discoveryWith(fake).getBoard(245)).toEqual({
      ok: true,
      value: { id: 245, name: 'Support', type: 'kanban', projectKey: 'OPS' },
    })
  })

  it('resolves the board filter JQL', async () => {
    const fake = new FakeFetch()
      .on('/rest/agile/1.0/board/245/configuration', { body: { filter: { id: '777' } } })
      .on('/rest/api/3/filter/777', { body: { jql: 'project = OPS ORDER BY Rank ASC' } })

    expect(await discoveryWith(fake).getBoardFilterJql(245)).toEqual({
      ok: true,
      value: 'project = OPS ORDER BY Rank ASC',
    })
  })

  it('passes agile API permission errors through so callers can degrade', async () => {
    const fake = new FakeFetch().on('/rest/agile/1.0/board/245', {
      status: 401,
      body: { message: 'Unauthorized; scope does not match' },
    })
    expect(await discoveryWith(fake).getBoard(245)).toEqual({
      ok: false,
      error: { kind: 'unauthorized', message: 'Unauthorized; scope does not match' },
    })
  })

  it('lists only custom fields, sorted by name', async () => {
    const fake = new FakeFetch().on('/rest/api/3/field', {
      body: [
        { id: 'summary', name: 'Summary', custom: false },
        { id: 'customfield_2', name: 'Module', custom: true },
        { id: 'customfield_1', name: 'Customer', custom: true },
      ],
    })
    expect(await discoveryWith(fake).listCustomFields()).toEqual({
      ok: true,
      value: [
        { id: 'customfield_1', name: 'Customer' },
        { id: 'customfield_2', name: 'Module' },
      ],
    })
  })
})

describe('JiraCloudDiscovery.getProjectOverview', () => {
  it('joins issue types with their workflow statuses and lists components', async () => {
    const fake = new FakeFetch()
      .on('/rest/api/3/project/OPS', {
        body: {
          key: 'OPS',
          name: 'Support L2',
          description: null,
          issueTypes: [
            { name: 'Incident', subtask: false, description: 'Something broke' },
            { name: 'Sub-task', subtask: true },
          ],
        },
      })
      .on('/rest/api/3/project/OPS/statuses', {
        body: [
          {
            name: 'Incident',
            statuses: [
              { name: 'To Do', statusCategory: { name: 'To Do' } },
              { name: 'Done', statusCategory: { name: 'Done' } },
            ],
          },
        ],
      })
      .on('/rest/api/3/project/OPS/components', { body: [{ name: 'Billing' }] })

    expect(await discoveryWith(fake).getProjectOverview('OPS')).toEqual({
      ok: true,
      value: {
        key: 'OPS',
        name: 'Support L2',
        description: '',
        issueTypes: [
          {
            name: 'Incident',
            description: 'Something broke',
            subtask: false,
            statuses: [
              { name: 'To Do', category: 'To Do' },
              { name: 'Done', category: 'Done' },
            ],
          },
          { name: 'Sub-task', description: '', subtask: true, statuses: [] },
        ],
        components: [{ name: 'Billing', description: '' }],
      },
    })
  })
})
