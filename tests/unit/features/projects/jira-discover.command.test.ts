import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '#src/core/kernel/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'

describe('ticketsmith jira discover (non-interactive)', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject()
  })
  afterEach(() => cli.cleanup())

  const saved = async () => {
    const project = await cli.services.projects.load('acme')
    if (!project.ok) throw new Error('project missing')
    return project.value.integrations.tickets
  }

  it('derives project and JQL from a readable board', async () => {
    cli.discovery.board = ok({ id: 245, name: 'Support', type: 'kanban', projectKey: 'OPS' })
    cli.discovery.filterJql = ok('project = OPS ORDER BY Rank ASC')

    expect(await cli.run('jira', 'discover', '--board', '245')).toBeNull()
    expect(await saved()).toMatchObject({
      projectKey: 'OPS',
      boardId: 245,
      jql: '(project = OPS) AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    })
  })

  it('falls back to the project JQL when the board API is not allowed', async () => {
    cli.discovery.board = err({ kind: 'unauthorized', message: 'scope does not match' })

    expect(await cli.run('jira', 'discover', '--board', '245', '--key', 'ops')).toBeNull()
    expect(cli.stderr).toMatch(/Jira Software scopes/)
    expect(await saved()).toMatchObject({
      projectKey: 'OPS',
      jql: 'project = "OPS" AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    })
  })

  it('asks for a project when nothing else is known', async () => {
    cli.discovery.board = err({ kind: 'forbidden', message: 'no' })
    expect((await cli.run('jira', 'discover', '--board', '245'))?.message).toMatch(/--key/)
  })

  it('keeps the existing project key without flags', async () => {
    await cli.withProject(testProject({ projectKey: 'OPS' }))
    expect(await cli.run('jira', 'discover')).toBeNull()
    expect((await saved())?.jql).toContain('project = "OPS"')
  })
})
