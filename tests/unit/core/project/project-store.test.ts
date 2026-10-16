import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePaths } from '#src/core/project/paths.ts'
import { ProjectStore } from '#src/core/project/project-store.ts'
import { testProject } from '#tests/support/fake-cli.ts'

describe('ProjectStore', () => {
  let home: string
  let store: ProjectStore
  const paths = () => resolvePaths({}, home)
  const projectDir = (name: string) => join(paths().projectsRoot, name)

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ticketsmith-'))
    store = new ProjectStore(paths())
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  it('saves project.yaml (owner-only, with a no-secrets header) and a .gitignore for local/', async () => {
    const project = testProject()
    expect((await store.save(project)).ok).toBe(true)

    const file = join(projectDir('acme'), 'project.yaml')
    const yaml = await readFile(file, 'utf8')
    expect(yaml).toMatch(/^# Ticketsmith project\..*\n# never put secrets here/s)
    expect(yaml).toContain('siteUrl: https://example.atlassian.net')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(projectDir('acme'), '.gitignore'), 'utf8')).toContain('local/')

    expect(await store.load('acme')).toEqual({ ok: true, value: project })
    expect(await store.list()).toEqual({ ok: true, value: ['acme'] })
  })

  it('allows projects without any integration', async () => {
    const project = testProject(null, 'docs-only')
    await store.save(project)
    expect(await store.load('docs-only')).toEqual({ ok: true, value: project })
  })

  it('reports a missing project and the exact invalid field', async () => {
    expect(await store.load('ghost')).toMatchObject({ ok: false, error: { kind: 'not-found' } })

    await store.save(testProject())
    const file = join(projectDir('acme'), 'project.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace('me@acme.test', 'not-an-email'))
    const result = await store.load('acme')
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'invalid') {
      expect(result.error.issues).toContain('integrations.tickets.email')
    }
  })

  it('resolves the explicit project before the active one and rejects unsafe names', async () => {
    expect(await store.resolveProjectName(undefined)).toEqual({
      ok: false,
      error: { kind: 'no-active-project' },
    })
    await store.setActiveProject('acme')
    expect(await store.resolveProjectName(undefined)).toEqual({ ok: true, value: 'acme' })
    expect(await store.resolveProjectName('other')).toEqual({ ok: true, value: 'other' })
    expect((await store.resolveProjectName('../etc')).ok).toBe(false)
  })

  it('links a project folder that lives elsewhere (e.g. a git clone)', async () => {
    const clone = join(home, 'clones', 'shared-acme')
    await mkdir(clone, { recursive: true })
    const other = new ProjectStore(resolvePaths({ XDG_DATA_HOME: join(home, 'elsewhere') }, home))
    await other.save(testProject({}, 'shared'))
    const savedFile = join(home, 'elsewhere', 'ticketsmith', 'projects', 'shared', 'project.yaml')
    await writeFile(join(clone, 'project.yaml'), await readFile(savedFile, 'utf8'))

    expect(await store.link(clone)).toMatchObject({ ok: true, value: { name: 'shared' } })
    expect(await store.list()).toEqual({ ok: true, value: ['shared'] })
    expect(await store.locate('shared')).toMatchObject({ ok: true, value: { root: clone } })
  })
})
