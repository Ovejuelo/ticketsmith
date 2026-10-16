import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyProfiles } from '#src/core/project/migrate-profiles.ts'
import { resolvePaths } from '#src/core/project/paths.ts'
import { ProjectStore } from '#src/core/project/project-store.ts'
import { testJira } from '#tests/support/fake-cli.ts'

describe('migrateLegacyProfiles', () => {
  let home: string
  const paths = () => resolvePaths({}, home)

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ticketsmith-migrate-'))
    const { legacy, configFile } = paths()
    await mkdir(legacy.profilesDir, { recursive: true })
    await writeFile(
      join(legacy.profilesDir, 'legacy.json'),
      JSON.stringify({ version: 1, name: 'legacy', tickets: testJira({ jql: 'project = OPS' }) }),
    )
    await writeFile(configFile, JSON.stringify({ activeProfile: 'legacy' }))
    await mkdir(join(legacy.dataDir('legacy'), 'audit'), { recursive: true })
    await writeFile(join(legacy.dataDir('legacy'), 'audit', 'run.jsonl'), '{}\n')
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  it('turns profiles into projects with the same name, data and active selection', async () => {
    const store = new ProjectStore(paths())
    const report = await migrateLegacyProfiles(paths(), store)

    expect(report).toEqual({ migrated: ['legacy'], failed: [] })
    expect(await store.load('legacy')).toMatchObject({
      ok: true,
      value: { version: 2, name: 'legacy', integrations: { tickets: { jql: 'project = OPS' } } },
    })
    expect(await store.resolveProjectName(undefined)).toEqual({ ok: true, value: 'legacy' })
    const projectRoot = join(paths().projectsRoot, 'legacy')
    expect(await readFile(join(projectRoot, 'local', 'audit', 'run.jsonl'), 'utf8')).toBe('{}\n')
    expect(await readdir(paths().legacy.profilesDir)).toEqual(['legacy.json.migrated'])
  })

  it('is a no-op the second time and without legacy profiles', async () => {
    const store = new ProjectStore(paths())
    await migrateLegacyProfiles(paths(), store)
    expect(await migrateLegacyProfiles(paths(), store)).toEqual({ migrated: [], failed: [] })

    const fresh = resolvePaths({}, join(home, 'nobody'))
    expect(await migrateLegacyProfiles(fresh, new ProjectStore(fresh))).toEqual({
      migrated: [],
      failed: [],
    })
  })

  it('reports invalid profiles without touching them', async () => {
    await writeFile(join(paths().legacy.profilesDir, 'broken.json'), '{"version":1}')
    const report = await migrateLegacyProfiles(paths(), new ProjectStore(paths()))
    expect(report.failed.map((failure) => failure.file)).toEqual([
      join(paths().legacy.profilesDir, 'broken.json'),
    ])
    expect(await readdir(paths().legacy.profilesDir)).toContain('broken.json')
  })
})
