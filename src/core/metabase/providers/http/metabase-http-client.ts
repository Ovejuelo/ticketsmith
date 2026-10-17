import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type {
  MetabaseClient,
  MetabaseDatabase,
  MetabaseError,
  NativeCard,
} from '../../metabase-client.port.ts'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export type MetabaseHttpClientOptions = {
  /** The Metabase site, e.g. https://metabase.acme.com */
  readonly url: string
  readonly apiKey: string
  readonly fetch?: FetchFn
  readonly timeoutMs?: number
}

const UserSchema = z.object({
  common_name: z.string().nullish(),
  email: z.string().nullish(),
})
const DatabaseSchema = z.object({ id: z.number(), name: z.string(), engine: z.string() })
// Newer versions wrap the list in { data }; older ones return the array.
const DatabasesSchema = z.union([
  z.object({ data: z.array(DatabaseSchema) }).transform((page) => page.data),
  z.array(DatabaseSchema),
])
const CreatedCardSchema = z.object({ id: z.number() })

/** Metabase REST API with an API key (`x-api-key`). Writes are never retried. */
export class MetabaseHttpClient implements MetabaseClient {
  readonly #url: string
  readonly #apiKey: string
  readonly #fetch: FetchFn
  readonly #timeoutMs: number

  constructor(options: MetabaseHttpClientOptions) {
    this.#url = options.url.replace(/\/+$/, '')
    this.#apiKey = options.apiKey
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? 20_000
  }

  async currentUser(): Promise<Result<{ readonly name: string }, MetabaseError>> {
    const user = await this.#request('GET', '/api/user/current', undefined, UserSchema)
    return user.ok ? ok({ name: user.value.common_name ?? user.value.email ?? 'API key' }) : user
  }

  databases(): Promise<Result<readonly MetabaseDatabase[], MetabaseError>> {
    return this.#request('GET', '/api/database', undefined, DatabasesSchema)
  }

  async createCard(
    card: NativeCard,
  ): Promise<Result<{ readonly id: number; readonly url: string }, MetabaseError>> {
    const created = await this.#request(
      'POST',
      '/api/card',
      {
        name: card.name,
        description: card.description,
        collection_id: card.collectionId,
        display: 'table',
        visualization_settings: {},
        dataset_query: {
          type: 'native',
          database: card.databaseId,
          native: { query: card.sql, 'template-tags': card.templateTags },
        },
      },
      CreatedCardSchema,
    )
    return created.ok
      ? ok({ id: created.value.id, url: `${this.#url}/question/${created.value.id}` })
      : created
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<Result<T, MetabaseError>> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: {
          'x-api-key': this.#apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      return err({ kind: 'network', message: String(error) })
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300)
      const message = `HTTP ${response.status}${text === '' ? '' : `: ${text}`}`
      if (response.status === 401) return err({ kind: 'unauthorized', message })
      if (response.status === 403) return err({ kind: 'forbidden', message })
      if (response.status === 404) return err({ kind: 'not-found', message: path })
      if (response.status >= 400 && response.status < 500) return err({ kind: 'rejected', message })
      return err({ kind: 'network', message })
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      return err({ kind: 'invalid-response', message: `${path}: not JSON` })
    }
    const parsed = schema.safeParse(json)
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: 'invalid-response', message: `${path}: ${z.prettifyError(parsed.error)}` })
  }
}
