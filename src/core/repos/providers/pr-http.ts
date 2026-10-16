import { err, ok, type Result } from '../../kernel/index.ts'
import type { PullRequestError } from '../pull-request-host.port.ts'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 30_000

/** One POST, never retried (creating a pull request is not idempotent), with clear errors. */
export const postJson = async (
  fetch: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Result<unknown, PullRequestError>> => {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return err({ kind: 'network', message: error instanceof Error ? error.message : String(error) })
  }
  const text = await response.text()
  const json = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })()
  if (response.ok) return ok(json)
  const detail = describeBody(json) || text.slice(0, 300) || response.statusText
  const kind: PullRequestError['kind'] =
    response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? 'forbidden'
        : response.status === 404
          ? 'not-found'
          : 'invalid'
  return err({ kind, message: `${response.status}: ${detail}` })
}

const describeBody = (json: unknown): string => {
  if (json === null || typeof json !== 'object') return ''
  const record = json as Record<string, unknown>
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  const errors = Array.isArray(record['errors'])
    ? record['errors']
        .map((e) =>
          typeof e === 'object' && e !== null
            ? String((e as Record<string, unknown>)['message'] ?? '')
            : String(e),
        )
        .filter((m) => m !== '')
        .join('; ')
    : ''
  const bitbucket = record['error'] as Record<string, unknown> | undefined
  const bitbucketMessage = typeof bitbucket?.['message'] === 'string' ? bitbucket['message'] : ''
  return [message, errors, bitbucketMessage].filter((part) => part !== '').join(' — ')
}
