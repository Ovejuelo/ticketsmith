import type { Result } from '../kernel/index.ts'
import type { TicketKey } from './ticket.schema.ts'
import type { TicketSourceError } from './ticket-source.port.ts'

export type TicketTransition = { readonly id: string; readonly name: string; readonly to: string }

/**
 * Writes to the ticket source (L2). Only the CLI uses it, after a person confirmed the exact
 * content in the terminal; no MCP tool ever receives a writer.
 */
export interface TicketWriter {
  addComment(
    key: TicketKey,
    markdown: string,
  ): Promise<Result<{ readonly url: string }, TicketSourceError>>
  transitions(key: TicketKey): Promise<Result<readonly TicketTransition[], TicketSourceError>>
  transition(key: TicketKey, transitionId: string): Promise<Result<void, TicketSourceError>>
  /** Whether the account may comment and transition (for doctor). */
  permissions(): Promise<
    Result<{ readonly addComments: boolean; readonly transitionIssues: boolean }, TicketSourceError>
  >
}
