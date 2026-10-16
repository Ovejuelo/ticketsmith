import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'

describe('ticketsmith project list|use|show', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('lists projects marking the active one', async () => {
    await cli.run('project', 'list')
    expect(cli.stdout).toContain('No projects yet')

    await cli.withProject(testProject({}, 'other'))
    await cli.withProject()
    await cli.run('project', 'list')
    expect(cli.stdout).toBe('* acme\n  other\n')
  })

  it('switches the active project only to an existing one', async () => {
    await cli.withProject()
    expect((await cli.run('project', 'use', 'ghost'))?.message).toMatch(/Project not found/)
    await cli.withProject(testProject({}, 'other'))
    await cli.run('project', 'use', 'acme')
    expect(await cli.services.projects.resolveProjectName(undefined)).toEqual({
      ok: true,
      value: 'acme',
    })
  })

  it('shows integrations and secret status but never the secret', async () => {
    await cli.withProject(testProject(), 'super-secret-value')
    await cli.run('project', 'show')
    expect(JSON.parse(cli.stdout)).toMatchObject({
      name: 'acme',
      integrations: ['tickets'],
      secrets: { 'jira-token': 'stored in keychain' },
    })
    expect(cli.stdout).not.toContain('super-secret-value')
  })
})
