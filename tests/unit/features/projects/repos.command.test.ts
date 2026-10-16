import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectPaths } from '#src/core/project/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { TestRemote } from '#tests/support/git-repos.ts'

describe('ticketsmith project add|refresh|remove repos', () => {
  let cli: FakeCli
  let api: TestRemote
  let web: TestRemote
  let paths: ProjectPaths

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject(null))
    api = new TestRemote({ fixture: 'api-express', branch: 'master' })
    api.branch('develop')
    web = new TestRemote({ fixture: 'web-react' })
    const located = await cli.services.projects.locate('acme')
    if (!located.ok) throw new Error('missing project')
    paths = located.value
  })
  afterEach(async () => {
    api[Symbol.dispose]()
    web[Symbol.dispose]()
    await cli.cleanup()
  })

  const load = async () => {
    const project = await cli.services.projects.load('acme')
    if (!project.ok) throw new Error('missing')
    return project.value
  }
  const knowledge = (file: string) => readFile(join(paths.knowledgeDir, file), 'utf8')

  it('adds a repository from flags: clones it, detects runtime and tests, and maps it', async () => {
    const flags = ['--url', api.url, '--name', 'api', '--feature-branch', 'develop']
    expect(await cli.run('project', 'add', 'repos', ...flags)).toBeNull()

    expect((await load()).integrations.repos).toEqual([
      {
        name: 'api',
        type: 'git',
        url: api.url,
        branches: { fix: 'master', feature: 'develop' },
        protectedBranches: ['master', 'develop'],
        runtime: { node: '20' },
        testCommand: 'npm test',
        allowCodeChanges: false,
        branchPattern: 'fix/{key}-{slug}',
      },
    ])
    expect(existsSync(join(paths.reposDir, 'api', 'src', 'server.js'))).toBe(true)
    expect(await knowledge('repos/api.md')).toContain('- `GET /:id` — src/routes/accounts.js:6')
    expect(await knowledge('brief.md')).toContain('repos/')
    expect(cli.stdout).toContain('repos ready in project "acme"')
  })

  it('rejects unknown branches, unreachable remotes and URLs with credentials', async () => {
    expect(
      (await cli.run('project', 'add', 'repos', '--url', api.url, '--fix-branch', 'prod'))?.message,
    ).toMatch(/not found on the remote: prod/)
    expect(
      (await cli.run('project', 'add', 'repos', '--url', 'file:///nonexistent/acme/repo'))?.message,
    ).toMatch(/Cannot reach/)
    expect(
      (await cli.run('project', 'add', 'repos', '--url', 'https://ana:secret@git.acme.dev/a.git'))
        ?.message,
    ).toMatch(/credential helper/)
    expect((await load()).integrations.repos).toBeUndefined()
  })

  it('maps several repositories and how they connect; a refresh re-maps only what moved', async () => {
    expect(await cli.run('project', 'add', 'repos', '--url', api.url, '--name', 'api')).toBeNull()
    expect(await cli.run('project', 'add', 'repos', '--url', web.url, '--name', 'web')).toBeNull()
    expect(await knowledge('repos/_connections.md')).toContain(
      'web src/api/accounts.js:3 → api src/routes/accounts.js:6',
    )

    expect(await cli.run('project', 'refresh', 'repos')).toBeNull()
    expect(cli.stderr).toMatch(/unchanged: api, web/)

    api.commit({ 'src/routes/health.js': "router.get('/ready', () => {})\n" })
    expect(await cli.run('project', 'refresh', 'repos')).toBeNull()
    expect(cli.stderr).toMatch(/unchanged: web\)/)
    expect(await knowledge('repos/api.md')).toContain('`GET /ready` — src/routes/health.js:1')

    expect(await cli.run('--json', 'project', 'status')).toBeNull()
    const status = JSON.parse(cli.stdout.slice(cli.stdout.lastIndexOf('\n{') + 1))
    expect(status.repositories.map((r: { name: string }) => r.name)).toEqual(['api', 'web'])
    expect(status.repositories[0].commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('removes one repository with its clone, or all of them with their knowledge', async () => {
    expect(await cli.run('project', 'add', 'repos', '--url', api.url, '--name', 'api')).toBeNull()
    expect(await cli.run('project', 'add', 'repos', '--url', web.url, '--name', 'web')).toBeNull()

    expect(await cli.run('project', 'remove', 'repos', '--repo', 'web', '--yes')).toBeNull()
    expect((await load()).integrations.repos?.map((r) => r.name)).toEqual(['api'])
    expect(existsSync(join(paths.reposDir, 'web'))).toBe(false)
    expect(existsSync(join(paths.reposDir, 'api'))).toBe(true)

    expect(await cli.run('project', 'remove', 'repos', '--yes')).toBeNull()
    expect((await load()).integrations).toEqual({})
    expect(existsSync(paths.reposDir)).toBe(false)
    expect(existsSync(join(paths.knowledgeDir, 'repos'))).toBe(false)
  })

  it('clones missing repositories on refresh, e.g. after linking the project on another machine', async () => {
    expect(await cli.run('project', 'add', 'repos', '--url', api.url, '--name', 'api')).toBeNull()
    await cli.run('project', 'remove', 'repos', '--repo', 'api', '--yes')
    await cli.withProject({
      ...(await load()),
      integrations: {
        repos: [
          {
            name: 'api',
            type: 'git',
            url: api.url,
            branches: { fix: 'master', feature: 'master' },
            protectedBranches: ['master'],
            runtime: {},
            allowCodeChanges: false,
            branchPattern: 'fix/{key}-{slug}',
          },
        ],
      },
    })
    expect(existsSync(join(paths.reposDir, 'api'))).toBe(false)
    expect(await cli.run('project', 'refresh', 'repos')).toBeNull()
    expect(existsSync(join(paths.reposDir, 'api', '.git'))).toBe(true)
  })
})
