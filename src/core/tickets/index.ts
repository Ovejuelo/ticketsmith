export { describeTicketSourceError } from './describe-error.ts'
export {
  defaultProjectJql,
  deriveOpenTicketsJql,
  type JiraBoardInfo,
  type JiraDiscovery,
  type JiraFieldInfo,
  type JiraIssueTypeInfo,
  type JiraProjectInfo,
  type JiraProjectOverview,
} from './jira-discovery.ts'
export { renderTicketMarkdown } from './render-ticket-markdown.ts'
export {
  type Ticket,
  type TicketAttachment,
  type TicketComment,
  type TicketKey,
  TicketKeySchema,
  TicketSchema,
  type TicketSummary,
  TicketSummarySchema,
} from './ticket.schema.ts'
export type {
  SourceIdentity,
  TicketPage,
  TicketQuery,
  TicketSource,
  TicketSourceError,
} from './ticket-source.port.ts'
