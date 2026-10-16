import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type {
  PullRequestError,
  PullRequestHost,
  PullRequestInput,
} from '../../pull-request-host.port.ts'
import { type FetchFn, postJson } from '../pr-http.ts'

const CreatedSchema = z.object({ html_url: z.string() })

/** GitHub and GitHub Enterprise: POST /repos/{owner}/{repo}/pulls with a token (Bearer). */
export class GitHubPullRequests implements PullRequestHost {
  readonly type = 'github'
  readonly #apiUrl: string
  readonly #fetch: FetchFn

  constructor(options: { readonly apiUrl?: string | undefined; readonly fetch?: FetchFn } = {}) {
    this.#apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.#fetch = options.fetch ?? fetch
  }

  async create(
    input: PullRequestInput,
    token: string,
  ): Promise<Result<{ readonly url: string }, PullRequestError>> {
    const result = await postJson(
      this.#fetch,
      `${this.#apiUrl}/repos/${input.owner}/${input.repo}/pulls`,
      {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      { title: input.title, head: input.head, base: input.base, body: input.body },
    )
    if (!result.ok) return result
    const parsed = CreatedSchema.safeParse(result.value)
    return parsed.success
      ? ok({ url: parsed.data.html_url })
      : err({ kind: 'invalid', message: 'GitHub answered without the pull request URL' })
  }
}
