import type { Result } from '../kernel/index.ts'
import type { RepositoryConfig } from '../project/index.ts'

export type PullRequestInput = {
  readonly owner: string
  readonly repo: string
  readonly head: string
  readonly base: string
  readonly title: string
  readonly body: string
}

export type PullRequestError = {
  readonly kind: 'unauthorized' | 'forbidden' | 'not-found' | 'invalid' | 'network'
  readonly message: string
}

/** Opens pull requests on one kind of git host. Providers live in providers/<host>/. */
export interface PullRequestHost {
  readonly type: HostType
  create(
    input: PullRequestInput,
    token: string,
  ): Promise<Result<{ readonly url: string }, PullRequestError>>
}

export type HostType = 'github' | 'bitbucket-cloud' | 'none'

export type RemotePath = {
  readonly hostname: string
  readonly owner: string
  readonly repo: string
}

/** `git@host:org/repo.git`, `ssh://git@host:22/org/repo`, `https://host/org/repo.git` → parts. */
export const parseRemote = (url: string): RemotePath | null => {
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(url)
  let hostname: string
  let path: string
  if (scp?.[1] !== undefined && scp[2] !== undefined && !url.includes('://')) {
    hostname = scp[1]
    path = scp[2]
  } else {
    try {
      const parsed = new URL(url)
      hostname = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  }
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
  const repo = parts.at(-1)
  const owner = parts.slice(0, -1).join('/')
  return repo === undefined || repo === '' || owner === ''
    ? null
    : { hostname: hostname.toLowerCase(), owner, repo }
}

/** The configured host, or the one recognized from the clone URL. */
export const hostTypeOf = (config: RepositoryConfig): HostType => {
  if (config.host !== undefined) return config.host.type
  const hostname = parseRemote(config.url)?.hostname
  if (hostname === 'github.com') return 'github'
  if (hostname === 'bitbucket.org') return 'bitbucket-cloud'
  return 'none'
}

/** The host's "create pull request" page, prefilled, when its URL scheme is known. */
export const compareUrl = (config: RepositoryConfig, head: string, base: string): string | null => {
  const remote = parseRemote(config.url)
  if (remote === null) return null
  const type = hostTypeOf(config)
  const web =
    config.host?.apiUrl === undefined
      ? `https://${remote.hostname}`
      : new URL(config.host.apiUrl).origin
  if (type === 'github') {
    return `${web}/${remote.owner}/${remote.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
  }
  if (type === 'bitbucket-cloud') {
    return `https://bitbucket.org/${remote.owner}/${remote.repo}/pull-requests/new?source=${encodeURIComponent(head)}&dest=${encodeURIComponent(base)}`
  }
  return null
}
