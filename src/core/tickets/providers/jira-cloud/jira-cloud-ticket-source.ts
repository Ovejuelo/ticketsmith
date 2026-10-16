import { err, ok, type Result } from '../../../kernel/index.ts'
import type { Ticket, TicketKey } from '../../ticket.schema.ts'
import type {
  SourceIdentity,
  TicketPage,
  TicketQuery,
  TicketSource,
  TicketSourceError,
} from '../../ticket-source.port.ts'
import {
  type JiraComment,
  JiraCommentPageSchema,
  JiraIssueSchema,
  JiraMyselfSchema,
  JiraSearchPageSchema,
} from './jira-api.schemas.ts'
import type { JiraHttpClient } from './jira-http-client.ts'
import { normalizeIssue, normalizeSearchIssue } from './normalize-issue.ts'

const ISSUE_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'priority',
  'description',
  'labels',
  'components',
  'reporter',
  'assignee',
  'created',
  'updated',
  'attachment',
  'issuelinks',
]
const SEARCH_FIELDS = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'updated']
const COMMENT_PAGE_SIZE = 100
const MAX_COMMENTS = 1_000
const MAX_SEARCH_PAGE = 100

export type JiraCloudTicketSourceOptions = {
  readonly siteUrl: string
  readonly customFields: Readonly<Record<string, string>>
}

export class JiraCloudTicketSource implements TicketSource {
  readonly kind = 'jira-cloud'
  readonly #client: JiraHttpClient
  readonly #options: JiraCloudTicketSourceOptions

  constructor(client: JiraHttpClient, options: JiraCloudTicketSourceOptions) {
    this.#client = client
    this.#options = options
  }

  async verifyConnection(): Promise<Result<SourceIdentity, TicketSourceError>> {
    const me = await this.#client.get('/rest/api/3/myself', {}, JiraMyselfSchema)
    if (!me.ok) return me
    return ok({
      accountId: me.value.accountId,
      displayName: me.value.displayName,
      siteUrl: this.#options.siteUrl,
    })
  }

  async getTicket(key: TicketKey): Promise<Result<Ticket, TicketSourceError>> {
    const fields = [...ISSUE_FIELDS, ...Object.values(this.#options.customFields)]
    const issue = await this.#client.get(
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      { fields: fields.join(',') },
      JiraIssueSchema,
    )
    if (!issue.ok) return issue.error.kind === 'not-found' ? err({ kind: 'not-found', key }) : issue

    const comments = await this.#fetchComments(key)
    if (!comments.ok) return comments

    const ticket = normalizeIssue(issue.value, comments.value, this.#options)
    return ticket.ok
      ? ticket
      : err({ kind: 'invalid-response', message: `${key}: ${ticket.error}` })
  }

  async search(query: TicketQuery): Promise<Result<TicketPage, TicketSourceError>> {
    const page = await this.#client.get(
      '/rest/api/3/search/jql',
      {
        jql: query.query,
        maxResults: Math.min(Math.max(query.limit, 1), MAX_SEARCH_PAGE),
        fields: SEARCH_FIELDS.join(','),
        nextPageToken: query.pageToken,
      },
      JiraSearchPageSchema,
    )
    if (!page.ok) return page

    const tickets = []
    for (const issue of page.value.issues) {
      const summary = normalizeSearchIssue(issue, this.#options.siteUrl)
      if (!summary.ok) {
        return err({ kind: 'invalid-response', message: `${issue.key}: ${summary.error}` })
      }
      tickets.push(summary.value)
    }
    return ok({ tickets, nextPageToken: page.value.nextPageToken ?? null })
  }

  async #fetchComments(key: string): Promise<Result<JiraComment[], TicketSourceError>> {
    const comments: JiraComment[] = []
    while (comments.length < MAX_COMMENTS) {
      const page = await this.#client.get(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
        { startAt: comments.length, maxResults: COMMENT_PAGE_SIZE, orderBy: 'created' },
        JiraCommentPageSchema,
      )
      if (!page.ok) return page
      comments.push(...page.value.comments)
      if (page.value.comments.length === 0 || comments.length >= page.value.total) break
    }
    return ok(comments)
  }
}
