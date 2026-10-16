import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err } from '#src/core/kernel/index.ts'
import { connectTicketSource, emptyProject } from '#src/features/projects/connect-ticket-source.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'

const input = {
  siteUrl: 'https://example.atlassian.net',
  email: 'me@acme.test',
  auth: 'scoped',
  token: 'new-token',
} as const

describe('connectTicketSource', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('verifies, stores the token and saves the project with its ticket source', async () => {
    const { project, identity } = await connectTicketSource(
      cli.services,
      emptyProject('acme'),
      input,
      { storeToken: true },
    )

    expect(identity.displayName).toBe('Me')
    expect(project.integrations.tickets).toMatchObject({ auth: 'scoped', cloudId: 'cloud-1' })
    expect(cli.connections[0]?.token).toBe('new-token')
    expect(cli.secrets.values.get('acme/jira-token')).toBe('new-token')
    expect(await cli.services.projects.load('acme')).toEqual({ ok: true, value: project })
  })

  it('persists nothing when JIRA rejects the credentials', async () => {
    cli.source = new InMemoryTicketSource([], {
      identity: err({ kind: 'unauthorized', message: 'Unauthorized' }),
    })

    await expect(
      connectTicketSource(cli.services, emptyProject('acme'), input, { storeToken: true }),
    ).rejects.toThrow(/rejected the credentials/)
    expect(cli.secrets.values.size).toBe(0)
    expect(await cli.services.projects.exists('acme')).toBe(false)
  })

  it('keeps discovery settings when reconnecting to the same site', async () => {
    const existing = testProject({ jql: 'project = OPS', boardId: 245, projectKey: 'OPS' })
    const { project } = await connectTicketSource(
      cli.services,
      existing,
      { ...input, auth: 'classic' },
      { storeToken: false },
    )

    expect(project.integrations.tickets).toMatchObject({
      auth: 'classic',
      jql: 'project = OPS',
      boardId: 245,
    })
    expect(project.integrations.tickets?.cloudId).toBeUndefined()
  })
})
