import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { sampleOverview } from '#tests/support/jira-overview.ts'

describe('ticketsmith project export|import|link', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
    cli.discovery.overview = ok(sampleOverview)
    await cli.run('project', 'refresh')
  })
  afterEach(() => cli.cleanup())

  it('exports only the shareable files, never local state or secrets', async () => {
    const out = join(cli.home, 'export')
    expect(await cli.run('project', 'export', out)).toBeNull()
    expect((await readdir(out)).sort()).toEqual(['.gitignore', 'knowledge', 'project.yaml'])
    expect(cli.stdout).toContain('No secrets or local state included.')

    await writeFile(join(out, 'extra.txt'), 'x')
    expect((await cli.run('project', 'export', out))?.message).toMatch(/not empty/)
  })

  it('imports an export as a new project and refuses to overwrite one', async () => {
    const out = join(cli.home, 'export')
    await cli.run('project', 'export', out)
    expect((await cli.run('project', 'import', out))?.message).toMatch(/already exists/)

    const other = await FakeCli.create()
    expect(await other.run('project', 'import', out)).toBeNull()
    expect(other.stdout).toContain('Imported project "acme"')
    expect(await other.services.projects.load('acme')).toMatchObject({
      ok: true,
      value: { name: 'acme' },
    })
    await other.cleanup()
  })

  it('links a clone in place', async () => {
    const out = join(cli.home, 'clone')
    await cli.run('project', 'export', out)
    const other = await FakeCli.create()
    expect(await other.run('project', 'link', out)).toBeNull()
    expect(await other.services.projects.locate('acme')).toMatchObject({
      ok: true,
      value: { root: out },
    })
    await other.cleanup()
  })

  it('rejects folders without a project', async () => {
    const empty = join(cli.home, 'empty')
    await mkdir(empty)
    expect((await cli.run('project', 'import', empty))?.message).toMatch(/no readable project.yaml/)
  })
})
