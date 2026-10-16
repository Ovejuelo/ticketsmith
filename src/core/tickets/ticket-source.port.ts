import type { Result } from '../kernel/index.ts'
import type { Ticket, TicketKey, TicketSummary } from './ticket.schema.ts'

/** Read-only ticket source. Implementations live in providers/<type>/ (JIRA Cloud first). */
export interface TicketSource {
  readonly kind: string
  verifyConnection(): Promise<Result<SourceIdentity, TicketSourceError>>
  getTicket(key: TicketKey): Promise<Result<Ticket, TicketSourceError>>
  search(query: TicketQuery): Promise<Result<TicketPage, TicketSourceError>>
}

export type SourceIdentity = {
  readonly accountId: string
  readonly displayName: string
  readonly siteUrl: string
}

export type TicketQuery = {
  /** The source's native query language (JQL for JIRA). */
  readonly query: string
  readonly limit: number
  readonly pageToken?: string
}

export type TicketPage = {
  readonly tickets: readonly TicketSummary[]
  readonly nextPageToken: string | null
}

export type TicketSourceError =
  | { readonly kind: 'not-found'; readonly key: string }
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly kind: 'invalid-query'; readonly message: string }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'invalid-response'; readonly message: string }
