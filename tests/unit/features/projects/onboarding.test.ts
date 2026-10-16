import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '#src/core/kernel/index.ts'
import { investigateProject, pendingInvestigations } from '#src/features/projects/onboarding.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'

const overview = {
  key: 'OPS',
  name: 'Support L2',
  description: '',
  issueTypes: [{ name: 'Incident', description: '', subtask: false, statuses: [] }],
  components: [],
}

describe('project onboarding', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  const opened = async () => {
    const project = await cli.services.projects.load('acme')
    const paths = await cli.services.projects.locate('acme')
    if (!project.ok || !paths.ok) throw new Error('project missing')
    return { project: project.value, paths: paths.value }
  }
  const brief = async () => readFile(join((await opened()).paths.knowledgeDir, 'brief.md'), 'utf8')

  it('writes a brief even for a project without integrations', async () => {
    await cli.withProject(testProject(null))
    expect(await investigateProject(cli.services, await opened())).toEqual([])
    expect(await brief()).toContain('None yet.')
  })

  it('records a failed step, keeps it pending and resumes it later', async () => {
    await cli.withProject(testProject({ projectKey: 'OPS' }))
    cli.discovery.overview = err({ kind: 'forbidden', message: 'no access' })

    const first = await investigateProject(cli.services, await opened())
    expect(first).toMatchObject([{ step: 'tickets', status: 'failed' }])
    expect(await pendingInvestigations(await opened())).toEqual(['tickets'])
    expect(await brief()).toContain('Nothing investigated yet.')

    cli.discovery.overview = ok(overview)
    const second = await investigateProject(cli.services, await opened(), ['tickets'])
    expect(second).toMatchObject([{ step: 'tickets', status: 'done' }])
    expect(await pendingInvestigations(await opened())).toEqual([])
    expect(await brief()).toContain('**[JIRA](tickets/jira.md)**: JIRA project OPS (Support L2)')
  })

  it('turns thrown errors (e.g. a missing token) into failed steps', async () => {
    await cli.withProject(testProject({ projectKey: 'OPS' }))
    cli.secrets.values.clear()
    expect(await investigateProject(cli.services, await opened())).toMatchObject([
      { step: 'tickets', status: 'failed', detail: expect.stringMatching(/No JIRA token/) },
    ])
  })
})
