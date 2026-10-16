import { describe, expect, it } from 'vitest'
import { ProjectSchema } from '#src/core/project/index.ts'
import { testProject, testRepository, withRepositories } from '#tests/support/fake-cli.ts'

const parse = (repos: unknown[]) =>
  ProjectSchema.safeParse({ ...testProject(null), integrations: { repos } })

const repo = (overrides: Record<string, unknown> = {}) => ({
  name: 'api',
  type: 'git',
  url: 'git@git.acme.dev:acme/api.git',
  branches: { fix: 'master', feature: 'develop' },
  ...overrides,
})

describe('repositories integration config', () => {
  it('accepts any number of repositories on any host', () => {
    const project = withRepositories(testProject(null), [
      testRepository('api'),
      testRepository('web', { url: 'https://github.com/acme/web.git' }),
      testRepository('tools', { url: 'ssh://git@git.acme.dev:7999/acme/tools.git' }),
      testRepository('local', { url: 'file:///srv/git/local' }),
    ])
    expect(ProjectSchema.safeParse(project).success).toBe(true)
  })

  it('protects the base branches unless told otherwise', () => {
    const result = parse([repo()])
    expect(result.success && result.data.integrations.repos?.[0]).toMatchObject({
      protectedBranches: ['master', 'develop'],
      runtime: {},
    })
    const explicit = parse([repo({ protectedBranches: ['master', 'stage'] })])
    expect(explicit.success && explicit.data.integrations.repos?.[0]?.protectedBranches).toEqual([
      'master',
      'stage',
    ])
  })

  it.each([
    'https://ana:app-password@bitbucket.org/acme/api.git',
    'https://x-token-auth:tok@bitbucket.org/acme/api.git',
  ])('rejects credentials embedded in the URL: %s', (url) => {
    const result = parse([repo({ url })])
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/credential helper/)
  })

  it.each(['ext::sh -c touch% /tmp/pwned', '/srv/git/api', 'ftp://host/repo'])(
    'rejects URLs that are not ssh, https or file: %s',
    (url) => {
      expect(parse([repo({ url })]).success).toBe(false)
    },
  )

  it('rejects branch names that could read as options or ranges', () => {
    expect(
      parse([repo({ branches: { fix: '--upload-pack=x', feature: 'develop' } })]).success,
    ).toBe(false)
    expect(
      parse([repo({ branches: { fix: 'master..develop', feature: 'develop' } })]).success,
    ).toBe(false)
  })

  it('reports duplicate names', () => {
    const result = parse([repo(), repo()])
    expect(result.error?.issues[0]).toMatchObject({
      message: 'Duplicate repository name "api"',
      path: ['integrations', 'repos', 1, 'name'],
    })
  })
})
