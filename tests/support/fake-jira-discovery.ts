import { err, ok, type Result } from '#src/core/kernel/index.ts'
import type {
  JiraBoardInfo,
  JiraDiscovery,
  JiraFieldInfo,
  JiraProjectInfo,
  JiraProjectOverview,
  TicketSourceError,
} from '#src/core/tickets/index.ts'

type Reply<T> = Result<T, TicketSourceError>

export class FakeJiraDiscovery implements JiraDiscovery {
  projects: Reply<readonly JiraProjectInfo[]> = ok([])
  boards: Reply<readonly JiraBoardInfo[]> = ok([])
  board: Reply<JiraBoardInfo> = err({ kind: 'not-found', key: 'board' })
  filterJql: Reply<string> = err({ kind: 'not-found', key: 'filter' })
  fields: Reply<readonly JiraFieldInfo[]> = ok([])
  overview: Reply<JiraProjectOverview> = err({ kind: 'not-found', key: 'project' })

  async listProjects() {
    return this.projects
  }
  async listBoards() {
    return this.boards
  }
  async getBoard() {
    return this.board
  }
  async getBoardFilterJql() {
    return this.filterJql
  }
  async listCustomFields() {
    return this.fields
  }
  async getProjectOverview() {
    return this.overview
  }
}
