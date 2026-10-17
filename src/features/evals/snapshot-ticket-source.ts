import { err, ok, type Result } from '../../core/kernel/index.ts'
import type {
  SourceIdentity,
  Ticket,
  TicketKey,
  TicketPage,
  TicketQuery,
  TicketSource,
  TicketSourceError,
} from '../../core/tickets/index.ts'

/** Serves an eval's masked snapshot as the only ticket: evals never reach the real ticket source. */
export class SnapshotTicketSource implements TicketSource {
  readonly kind = 'eval-snapshot'
  readonly #ticket: Ticket

  constructor(ticket: Ticket) {
    this.#ticket = ticket
  }

  async verifyConnection(): Promise<Result<SourceIdentity, TicketSourceError>> {
    return ok({ accountId: 'eval', displayName: 'Eval snapshot', siteUrl: 'about:blank' })
  }

  async getTicket(key: TicketKey): Promise<Result<Ticket, TicketSourceError>> {
    return key === this.#ticket.key ? ok(this.#ticket) : err({ kind: 'not-found', key })
  }

  async search(_query: TicketQuery): Promise<Result<TicketPage, TicketSourceError>> {
    return ok({ tickets: [], nextPageToken: null })
  }
}
