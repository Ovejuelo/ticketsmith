import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectPaths } from '#src/core/project/index.ts'
import {
  findRepository,
  projectRepositories,
  suggestRepositoryName,
} from '#src/core/repos/repositories.ts'
import { testProject, testRepository, withRepositories } from '#tests/support/fake-cli.ts'

describe('suggestRepositoryName', () => {
  it.each([
    ['git@bitbucket.org:acme/billing-backend.git', 'billing-backend'],
    ['https://github.com/acme/Billing_Frontend', 'billing_frontend'],
    ['ssh://git@git.acme.dev:7999/acme/tools.git/', 'tools'],
    ['file:///srv/git/My.Repo', 'my-repo'],
  ])('%s → %s', (url, name) => {
    expect(suggestRepositoryName(url)).toBe(name)
  })
})

describe('findRepository', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ticketsmith-repos-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds cloned repositories and explains unknown or missing clones', () => {
    const paths = projectPaths(root)
    const repositories = projectRepositories(
      withRepositories(testProject(null), [testRepository('api'), testRepository('web')]),
      paths,
    )
    mkdirSync(join(paths.reposDir, 'api', '.git'), { recursive: true })

    const api = findRepository(repositories, 'api')
    expect(api.ok && api.value.dir).toBe(join(root, 'local', 'repos', 'api'))
    expect(findRepository(repositories, 'web')).toEqual({
      ok: false,
      error: 'Repository "web" is not cloned yet. Run `ticketsmith project refresh repos`.',
    })
    expect(findRepository(repositories, 'nope')).toEqual({
      ok: false,
      error: 'Unknown repository "nope". Known: api, web.',
    })
  })
})
