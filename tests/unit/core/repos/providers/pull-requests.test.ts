import { describe, expect, it } from 'vitest'
import { compareUrl, hostTypeOf, parseRemote } from '#src/core/repos/index.ts'
import { BitbucketCloudPullRequests } from '#src/core/repos/providers/bitbucket-cloud/bitbucket-pull-requests.ts'
import { GitHubPullRequests } from '#src/core/repos/providers/github/github-pull-requests.ts'
import { testRepository } from '#tests/support/fake-cli.ts'
import { FakeFetch } from '#tests/support/fake-fetch.ts'

const input = {
  owner: 'acme',
  repo: 'billing-backend',
  head: 'hotfix/OPS-7-pago',
  base: 'master',
  title: 'fix(OPS-7): reject expired cards',
  body: 'Closes OPS-7.',
}

describe('remotes and hosts', () => {
  it.each([
    [
      'git@github.com:acme/billing-backend.git',
      { hostname: 'github.com', owner: 'acme', repo: 'billing-backend' },
    ],
    [
      'https://bitbucket.org/acme/billing-backend.git',
      { hostname: 'bitbucket.org', owner: 'acme', repo: 'billing-backend' },
    ],
    [
      'ssh://git@git.acme.dev:7999/team/sub/tools.git',
      { hostname: 'git.acme.dev', owner: 'team/sub', repo: 'tools' },
    ],
    ['file:///srv/git/x', { hostname: '', owner: 'srv/git', repo: 'x' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemote(url)).toEqual(expected)
  })

  it('detects the host from the URL unless configured, and builds the fallback link', () => {
    const github = testRepository('api', { url: 'git@github.com:acme/api.git' })
    const bitbucket = testRepository('api', { url: 'git@bitbucket.org:acme/api.git' })
    const gitlab = testRepository('api', { url: 'git@gitlab.com:acme/api.git' })
    expect([hostTypeOf(github), hostTypeOf(bitbucket), hostTypeOf(gitlab)]).toEqual([
      'github',
      'bitbucket-cloud',
      'none',
    ])
    expect(
      hostTypeOf({ ...gitlab, host: { type: 'github', apiUrl: 'https://github.acme.dev/api/v3' } }),
    ).toBe('github')

    expect(compareUrl(github, 'fix/OPS-7', 'main')).toBe(
      'https://github.com/acme/api/compare/main...fix%2FOPS-7?expand=1',
    )
    expect(compareUrl(bitbucket, 'fix/OPS-7', 'master')).toBe(
      'https://bitbucket.org/acme/api/pull-requests/new?source=fix%2FOPS-7&dest=master',
    )
    expect(compareUrl(gitlab, 'fix/OPS-7', 'main')).toBeNull()
  })
})

describe('GitHubPullRequests', () => {
  it('posts the pull request with a bearer token and returns its URL', async () => {
    const http = new FakeFetch().on('/repos/acme/billing-backend/pulls', {
      status: 201,
      body: { number: 12, html_url: 'https://github.com/acme/billing-backend/pull/12' },
    })
    const result = await new GitHubPullRequests({ fetch: http.fetch }).create(input, 'ghp_token')
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://github.com/acme/billing-backend/pull/12' },
    })
    const [request] = http.requests
    expect(request?.url.href).toBe('https://api.github.com/repos/acme/billing-backend/pulls')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('authorization')).toBe('Bearer ghp_token')
    expect(request?.body).toEqual({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    })
  })

  it('uses the Enterprise API URL and explains rejections without retrying', async () => {
    const http = new FakeFetch().on('/pulls', {
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ message: 'A pull request already exists for acme:hotfix/OPS-7-pago.' }],
      },
    })
    const result = await new GitHubPullRequests({
      apiUrl: 'https://github.acme.dev/api/v3',
      fetch: http.fetch,
    }).create(input, 't')
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid',
        message:
          '422: Validation Failed — A pull request already exists for acme:hotfix/OPS-7-pago.',
      },
    })
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.url.origin).toBe('https://github.acme.dev')
  })
})

describe('BitbucketCloudPullRequests', () => {
  it('posts source and destination branches and returns the web link', async () => {
    const http = new FakeFetch().on('/2.0/repositories/acme/billing-backend/pullrequests', {
      status: 201,
      body: {
        id: 5,
        links: { html: { href: 'https://bitbucket.org/acme/billing-backend/pull-requests/5' } },
      },
    })
    const result = await new BitbucketCloudPullRequests({ fetch: http.fetch }).create(
      input,
      'bb_token',
    )
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://bitbucket.org/acme/billing-backend/pull-requests/5' },
    })
    expect(http.requests[0]?.headers.get('authorization')).toBe('Bearer bb_token')
    expect(http.requests[0]?.body).toEqual({
      title: input.title,
      description: input.body,
      source: { branch: { name: input.head } },
      destination: { branch: { name: input.base } },
    })
  })

  it('reports an expired or unscoped token', async () => {
    const http = new FakeFetch().on('/pullrequests', {
      status: 401,
      body: { type: 'error', error: { message: 'Token is invalid or expired' } },
    })
    expect(await new BitbucketCloudPullRequests({ fetch: http.fetch }).create(input, 'x')).toEqual({
      ok: false,
      error: { kind: 'unauthorized', message: '401: Token is invalid or expired' },
    })
  })
})
