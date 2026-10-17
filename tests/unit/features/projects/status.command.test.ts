import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { sampleOverview } from '#tests/support/jira-overview.ts'

describe('ticketsmith project status', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
    cli.discovery.overview = ok(sampleOverview)
  })
  afterEach(() => cli.cleanup())

  it('shows configured integrations as pending until investigated', async () => {
    await cli.run('--json', 'project', 'status')
    expect(JSON.parse(cli.stdout)).toMatchObject({
      name: 'acme',
      active: true,
      git: false,
      integrations: [
        { integration: 'tickets', configured: true, investigation: null },
        { integration: 'databases', configured: false, investigation: null },
        { integration: 'repos', configured: false, investigation: null },
        { integration: 'metabase', configured: false, investigation: null },
      ],
      repositories: [],
      knowledge: [],
    })
  })

  it('shows the investigation result and the knowledge files after a refresh', async () => {
    await cli.run('project', 'refresh')
    await cli.run('--json', 'project', 'status')
    expect(JSON.parse(cli.stdout)).toMatchObject({
      integrations: [
        {
          integration: 'tickets',
          investigation: { status: 'done', detail: expect.stringContaining('JIRA project OPS') },
        },
        { integration: 'databases', configured: false },
        { integration: 'repos', configured: false },
        { integration: 'metabase', configured: false },
      ],
      knowledge: ['brief.md', 'ticket-types.md', 'tickets/jira.md'],
    })
  })
})
