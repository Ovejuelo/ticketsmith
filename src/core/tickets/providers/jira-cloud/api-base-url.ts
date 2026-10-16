import { err, ok, type Result } from '../../../kernel/index.ts'
import type { TicketSourceError } from '../../ticket-source.port.ts'
import { TenantInfoSchema } from './jira-api.schemas.ts'
import type { FetchFn } from './jira-http-client.ts'

export type JiraAuth =
  | { readonly kind: 'classic'; readonly siteUrl: string }
  | { readonly kind: 'scoped'; readonly cloudId: string }

/** Scoped API tokens only work through the api.atlassian.com gateway, never the site URL. */
export const apiBaseUrl = (auth: JiraAuth): string =>
  auth.kind === 'scoped' ? `https://api.atlassian.com/ex/jira/${auth.cloudId}` : auth.siteUrl

/** Public, unauthenticated endpoint that maps a site to its cloudId. */
export const resolveCloudId = async (
  siteUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<Result<string, TicketSourceError>> => {
  try {
    const response = await fetchFn(`${siteUrl.replace(/\/+$/, '')}/_edge/tenant_info`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return err({ kind: 'not-found', key: siteUrl })
    }
    const parsed = TenantInfoSchema.safeParse(await response.json())
    return parsed.success
      ? ok(parsed.data.cloudId)
      : err({ kind: 'invalid-response', message: `${siteUrl} did not return a cloudId` })
  } catch (error) {
    return err({ kind: 'network', message: String(error) })
  }
}
