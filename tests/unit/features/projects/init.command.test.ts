import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli } from '#tests/support/fake-cli.ts'

describe('ticketsmith project init (non-interactive)', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('requires a name', async () => {
    expect((await cli.run('project', 'init'))?.message).toMatch(/needs --name/)
  })

  it('creates a project without integrations and activates it', async () => {
    expect(await cli.run('project', 'init', '--name', 'docs-only')).toBeNull()
    expect(await cli.services.projects.load('docs-only')).toMatchObject({
      ok: true,
      value: { name: 'docs-only', integrations: {} },
    })
    expect(await cli.services.projects.resolveProjectName(undefined)).toEqual({
      ok: true,
      value: 'docs-only',
    })
  })

  it('adds a ticket source only with every JIRA flag and a token', async () => {
    expect(
      (await cli.run('project', 'init', '--name', 'acme', '--site', 'example.atlassian.net'))
        ?.message,
    ).toMatch(/needs --site, --email and --auth/)

    const flags = ['--site', 'example.atlassian.net', '--email', 'me@acme.test', '--auth', 'scoped']
    expect((await cli.run('project', 'init', '--name', 'acme', ...flags))?.message).toMatch(
      /TICKETSMITH_JIRA_TOKEN/,
    )

    await cli.secrets.set({ project: 'acme', name: 'jira-token' }, 'secret-token')
    expect(await cli.run('project', 'init', '--name', 'acme', ...flags)).toBeNull()
    expect(await cli.services.projects.load('acme')).toMatchObject({
      ok: true,
      value: { integrations: { tickets: { siteUrl: 'https://example.atlassian.net' } } },
    })
  })
})
