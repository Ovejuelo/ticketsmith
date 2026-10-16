import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type {
  PullRequestError,
  PullRequestHost,
  PullRequestInput,
} from '../../pull-request-host.port.ts'
import { type FetchFn, postJson } from '../pr-http.ts'

const CreatedSchema = z.object({ links: z.object({ html: z.object({ href: z.string() }) }) })

/**
 * Bitbucket Cloud: POST /2.0/repositories/{workspace}/{repo}/pullrequests with an API token
 * (Bearer; it needs the pull request write scope).
 */
export class BitbucketCloudPullRequests implements PullRequestHost {
  readonly type = 'bitbucket-cloud'
  readonly #apiUrl: string
  readonly #fetch: FetchFn

  constructor(options: { readonly apiUrl?: string | undefined; readonly fetch?: FetchFn } = {}) {
    this.#apiUrl = (options.apiUrl ?? 'https://api.bitbucket.org').replace(/\/+$/, '')
    this.#fetch = options.fetch ?? fetch
  }

  async create(
    input: PullRequestInput,
    token: string,
  ): Promise<Result<{ readonly url: string }, PullRequestError>> {
    const result = await postJson(
      this.#fetch,
      `${this.#apiUrl}/2.0/repositories/${input.owner}/${input.repo}/pullrequests`,
      { authorization: `Bearer ${token}` },
      {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.head } },
        destination: { branch: { name: input.base } },
      },
    )
    if (!result.ok) return result
    const parsed = CreatedSchema.safeParse(result.value)
    return parsed.success
      ? ok({ url: parsed.data.links.html.href })
      : err({ kind: 'invalid', message: 'Bitbucket answered without the pull request URL' })
  }
}
