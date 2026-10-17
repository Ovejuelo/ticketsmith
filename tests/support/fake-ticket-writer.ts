import { err, ok, type Result } from '#src/core/kernel/index.ts'
import type { TicketSourceError, TicketTransition, TicketWriter } from '#src/core/tickets/index.ts'

/** Records writes instead of posting them. */
export class FakeTicketWriter implements TicketWriter {
  readonly comments: { key: string; markdown: string }[] = []
  readonly moved: { key: string; transitionId: string }[] = []
  available: TicketTransition[] = [
    { id: '21', name: 'Start progress', to: 'In Progress' },
    { id: '31', name: 'Resolve', to: 'Done' },
  ]
  allowed = { addComments: true, transitionIssues: true }
  failure: TicketSourceError | null = null

  async addComment(
    key: string,
    markdown: string,
  ): Promise<Result<{ url: string }, TicketSourceError>> {
    if (this.failure !== null) return err(this.failure)
    this.comments.push({ key, markdown })
    return ok({
      url: `https://example.atlassian.net/browse/${key}?focusedCommentId=${10000 + this.comments.length}`,
    })
  }

  async transitions(): Promise<Result<readonly TicketTransition[], TicketSourceError>> {
    return ok(this.available)
  }

  async transition(key: string, transitionId: string): Promise<Result<void, TicketSourceError>> {
    if (this.failure !== null) return err(this.failure)
    this.moved.push({ key, transitionId })
    return ok(undefined)
  }

  async permissions() {
    return ok(this.allowed)
  }
}
