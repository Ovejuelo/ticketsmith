import { z } from 'zod'
import { err, type Logger, ok, type Result } from '../../../kernel/index.ts'
import type { TicketSourceError } from '../../ticket-source.port.ts'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>
export type Query = Readonly<Record<string, string | number | undefined>>

export type JiraHttpClientOptions = {
  /** Site URL for classic tokens, or https://api.atlassian.com/ex/jira/{cloudId} for scoped ones. */
  readonly baseUrl: string
  readonly email: string
  readonly token: string
  readonly logger: Logger
  readonly fetch?: FetchFn
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

const MAX_BACKOFF_MS = 30_000
const MAX_RETRY_AFTER_MS = 60_000

/** Read-only JIRA REST client: Basic auth, timeouts, retries on transient errors, zod-validated responses. */
export class JiraHttpClient {
  readonly #baseUrl: string
  readonly #authorization: string
  readonly #logger: Logger
  readonly #fetch: FetchFn
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #timeoutMs: number
  readonly #maxRetries: number

  constructor(options: JiraHttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`
    this.#logger = options.logger
    this.#fetch = options.fetch ?? fetch
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#random = options.random ?? Math.random
    this.#timeoutMs = options.timeoutMs ?? 20_000
    this.#maxRetries = options.maxRetries ?? 3
  }

  async get<T>(
    path: string,
    query: Query,
    schema: z.ZodType<T>,
  ): Promise<Result<T, TicketSourceError>> {
    const url = this.#url(path, query)

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.#maxRetries
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { Authorization: this.#authorization, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (error) {
        this.#logger.debug({ path, attempt, error: String(error) }, 'jira request failed')
        if (canRetry) {
          await this.#sleep(this.#backoff(attempt))
          continue
        }
        return err({ kind: 'network', message: describeNetworkError(error, this.#timeoutMs) })
      }

      this.#logger.debug({ path, attempt, status: response.status }, 'jira response')
      if (response.ok) return parseBody(response, schema, path)

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      if (isTransient(response.status) && canRetry) {
        await response.body?.cancel()
        await this.#sleep(retryAfterMs ?? this.#backoff(attempt))
        continue
      }
      return err(await toError(response, path, retryAfterMs))
    }
  }

  #url(path: string, query: Query): string {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    return url.toString()
  }

  // Exponential backoff with jitter in [50%, 100%] of the step.
  #backoff(attempt: number): number {
    const step = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
    return Math.round(step * (0.5 + this.#random() * 0.5))
  }
}

const isTransient = (status: number): boolean => status === 429 || status >= 500

const parseRetryAfter = (header: string | null): number | null => {
  if (header === null) return null
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null
}

const describeNetworkError = (error: unknown, timeoutMs: number): string =>
  error instanceof Error && error.name === 'TimeoutError'
    ? `Request timed out after ${timeoutMs} ms`
    : String(error)

const parseBody = async <T>(
  response: Response,
  schema: z.ZodType<T>,
  path: string,
): Promise<Result<T, TicketSourceError>> => {
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return err({ kind: 'invalid-response', message: `${path}: response is not JSON` })
  }
  const parsed = schema.safeParse(json)
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: 'invalid-response', message: `${path}: ${z.prettifyError(parsed.error)}` })
}

const JiraErrorBodySchema = z.object({
  errorMessages: z.array(z.string()).default([]),
  errors: z.record(z.string(), z.string()).default({}),
  message: z.string().optional(),
})

const errorMessage = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '')
  try {
    const body = JiraErrorBodySchema.parse(JSON.parse(text))
    const messages = [...body.errorMessages, ...Object.values(body.errors)]
    if (body.message) messages.push(body.message)
    if (messages.length > 0) return messages.join('; ')
  } catch {
    // Not a JIRA error body; fall back to the status text.
  }
  return `HTTP ${response.status} ${response.statusText}`.trim()
}

const toError = async (
  response: Response,
  path: string,
  retryAfterMs: number | null,
): Promise<TicketSourceError> => {
  const message = await errorMessage(response)
  switch (response.status) {
    case 400:
      return { kind: 'invalid-query', message }
    case 401:
      return { kind: 'unauthorized', message }
    case 403:
      return { kind: 'forbidden', message }
    case 404:
      return { kind: 'not-found', key: path }
    case 429:
      return { kind: 'rate-limited', retryAfterMs }
    default:
      return { kind: 'network', message }
  }
}
