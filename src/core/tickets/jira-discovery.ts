import type { Result } from '../kernel/index.ts'
import type { TicketSourceError } from './ticket-source.port.ts'

/** JIRA-specific setup helpers used by `init` and `jira discover`. Not part of TicketSource. */
export interface JiraDiscovery {
  listProjects(): Promise<Result<readonly JiraProjectInfo[], TicketSourceError>>
  listBoards(projectKey?: string): Promise<Result<readonly JiraBoardInfo[], TicketSourceError>>
  getBoard(boardId: number): Promise<Result<JiraBoardInfo, TicketSourceError>>
  /** The JQL of the board's saved filter, as configured in JIRA. */
  getBoardFilterJql(boardId: number): Promise<Result<string, TicketSourceError>>
  listCustomFields(): Promise<Result<readonly JiraFieldInfo[], TicketSourceError>>
  /** Issue types with their workflow statuses, and components, of one JIRA project. */
  getProjectOverview(projectKey: string): Promise<Result<JiraProjectOverview, TicketSourceError>>
}

export type JiraIssueTypeInfo = {
  readonly name: string
  readonly description: string
  readonly subtask: boolean
  readonly statuses: readonly { readonly name: string; readonly category: string }[]
}

export type JiraProjectOverview = {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly issueTypes: readonly JiraIssueTypeInfo[]
  readonly components: readonly { readonly name: string; readonly description: string }[]
}

export type JiraProjectInfo = { readonly key: string; readonly name: string }

export type JiraBoardInfo = {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly projectKey: string | null
}

export type JiraFieldInfo = { readonly id: string; readonly name: string }

/** Open tickets first by priority; used when there is no board or as a board-derived default. */
export const defaultProjectJql = (projectKey: string): string =>
  `project = "${projectKey}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`

export const deriveOpenTicketsJql = (filterJql: string): string => {
  const withoutOrder = filterJql.replace(/\s+ORDER\s+BY\s[\s\S]*$/i, '').trim()
  return `(${withoutOrder}) AND statusCategory != Done ORDER BY priority DESC, updated DESC`
}
