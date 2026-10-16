import { err, ok, type Result } from '#src/core/kernel/index.ts'
import type {
  SourceIdentity,
  Ticket,
  TicketKey,
  TicketPage,
  TicketQuery,
  TicketSource,
  TicketSourceError,
} from '#src/core/tickets/index.ts'

export class InMemoryTicketSource implements TicketSource {
  readonly kind = 'memory'
  readonly queries: TicketQuery[] = []
  readonly #tickets: Ticket[]
  readonly #identity: Result<SourceIdentity, TicketSourceError>
  readonly #pageSize: number

  constructor(
    tickets: readonly Ticket[] = [],
    options: { identity?: Result<SourceIdentity, TicketSourceError>; pageSize?: number } = {},
  ) {
    this.#tickets = [...tickets]
    this.#identity =
      options.identity ??
      ok({ accountId: 'acc-me', displayName: 'Me', siteUrl: 'https://example.atlassian.net' })
    this.#pageSize = options.pageSize ?? 100
  }

  async verifyConnection(): Promise<Result<SourceIdentity, TicketSourceError>> {
    return this.#identity
  }

  async getTicket(key: TicketKey): Promise<Result<Ticket, TicketSourceError>> {
    const ticket = this.#tickets.find((candidate) => candidate.key === key)
    return ticket ? ok(ticket) : err({ kind: 'not-found', key })
  }

  async search(query: TicketQuery): Promise<Result<TicketPage, TicketSourceError>> {
    this.queries.push(query)
    const start = Number(query.pageToken ?? 0)
    const size = Math.min(query.limit, this.#pageSize)
    const end = start + size
    return ok({
      tickets: this.#tickets.slice(start, end),
      nextPageToken: end < this.#tickets.length ? String(end) : null,
    })
  }
}
