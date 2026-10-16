import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { sampleOverview } from '#tests/support/jira-overview.ts'

describe('ticketsmith project rename', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }, 'legacy'))
    cli.discovery.overview = ok(sampleOverview)
    await cli.run('project', 'refresh')
  })
  afterEach(() => cli.cleanup())

  it('moves the folder, keychain entry and active project, and rebuilds the brief', async () => {
    expect(await cli.run('project', 'rename', 'legacy', 'billing')).toBeNull()

    expect(await cli.services.projects.exists('legacy')).toBe(false)
    expect(await cli.services.projects.load('billing')).toMatchObject({
      ok: true,
      value: { name: 'billing', integrations: { tickets: { projectKey: 'OPS' } } },
    })
    expect(await cli.services.projects.resolveProjectName(undefined)).toEqual({
      ok: true,
      value: 'billing',
    })
    expect(cli.secrets.values.get('billing/jira-token')).toBe('secret-token')
    expect(cli.secrets.values.has('legacy/jira-token')).toBe(false)

    const paths = await cli.services.projects.locate('billing')
    if (!paths.ok) throw new Error('missing')
    await stat(paths.value.sqlite)
    expect(await readFile(join(paths.value.knowledgeDir, 'brief.md'), 'utf8')).toContain(
      '# Project brief: billing',
    )
  })

  it('refuses existing or invalid names', async () => {
    await cli.withProject(testProject({}, 'other'))
    expect((await cli.run('project', 'rename', 'legacy', 'other'))?.message).toMatch(
      /already exists/,
    )
    expect((await cli.run('project', 'rename', 'legacy', 'Bad Name'))?.message).toMatch(/new name/)
    expect((await cli.run('project', 'rename', 'ghost', 'x'))?.message).toMatch(/Project not found/)
  })
})
