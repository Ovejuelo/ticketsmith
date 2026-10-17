import { ok, type Result } from '../../../kernel/index.ts'
import type {
  JiraBoardInfo,
  JiraDiscovery,
  JiraFieldInfo,
  JiraProjectInfo,
  JiraProjectOverview,
} from '../../jira-discovery.ts'
import type { TicketSourceError } from '../../ticket-source.port.ts'
import {
  type JiraBoard,
  JiraBoardConfigurationSchema,
  JiraBoardPageSchema,
  JiraBoardSchema,
  JiraComponentListSchema,
  JiraFieldListSchema,
  JiraFilterSchema,
  JiraProjectDetailSchema,
  JiraProjectPageSchema,
  JiraProjectStatusesSchema,
} from './jira-api.schemas.ts'
import type { JiraHttpClient } from './jira-http-client.ts'

const PAGE_SIZE = 50
const MAX_PAGES = 20

export class JiraCloudDiscovery implements JiraDiscovery {
  readonly #client: JiraHttpClient

  constructor(client: JiraHttpClient) {
    this.#client = client
  }

  async listProjects(): Promise<Result<readonly JiraProjectInfo[], TicketSourceError>> {
    const projects: JiraProjectInfo[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#client.get(
        '/rest/api/3/project/search',
        { startAt: page * PAGE_SIZE, maxResults: PAGE_SIZE, orderBy: 'key' },
        JiraProjectPageSchema,
      )
      if (!result.ok) return result
      projects.push(...result.value.values.map(({ key, name }) => ({ key, name })))
      if (result.value.isLast) break
    }
    return ok(projects)
  }

  async listBoards(
    projectKey?: string,
  ): Promise<Result<readonly JiraBoardInfo[], TicketSourceError>> {
    const boards: JiraBoardInfo[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#client.get(
        '/rest/agile/1.0/board',
        { startAt: page * PAGE_SIZE, maxResults: PAGE_SIZE, projectKeyOrId: projectKey },
        JiraBoardPageSchema,
      )
      if (!result.ok) return result
      boards.push(...result.value.values.map(toBoardInfo))
      if (result.value.isLast) break
    }
    return ok(boards)
  }

  async getBoard(boardId: number): Promise<Result<JiraBoardInfo, TicketSourceError>> {
    const result = await this.#client.get(`/rest/agile/1.0/board/${boardId}`, {}, JiraBoardSchema)
    return result.ok ? ok(toBoardInfo(result.value)) : result
  }

  async getBoardFilterJql(boardId: number): Promise<Result<string, TicketSourceError>> {
    const config = await this.#client.get(
      `/rest/agile/1.0/board/${boardId}/configuration`,
      {},
      JiraBoardConfigurationSchema,
    )
    if (!config.ok) return config
    const filter = await this.#client.get(
      `/rest/api/3/filter/${encodeURIComponent(config.value.filter.id)}`,
      {},
      JiraFilterSchema,
    )
    return filter.ok ? ok(filter.value.jql) : filter
  }

  getProjectOverview(projectKey: string): Promise<Result<JiraProjectOverview, TicketSourceError>> {
    return projectOverview(this.#client, projectKey)
  }

  async listCustomFields(): Promise<Result<readonly JiraFieldInfo[], TicketSourceError>> {
    const result = await this.#client.get('/rest/api/3/field', {}, JiraFieldListSchema)
    if (!result.ok) return result
    return ok(
      result.value
        .filter((field) => field.custom)
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  }
}

export const projectOverview = async (
  client: JiraHttpClient,
  projectKey: string,
  api = '/rest/api/3',
): Promise<Result<JiraProjectOverview, TicketSourceError>> => {
  const path = `${api}/project/${encodeURIComponent(projectKey)}`
  const detail = await client.get(path, {}, JiraProjectDetailSchema)
  if (!detail.ok) return detail
  const statuses = await client.get(`${path}/statuses`, {}, JiraProjectStatusesSchema)
  if (!statuses.ok) return statuses
  const components = await client.get(`${path}/components`, {}, JiraComponentListSchema)
  if (!components.ok) return components

  const statusesByType = new Map(statuses.value.map((type) => [type.name, type.statuses]))
  return ok({
    key: detail.value.key,
    name: detail.value.name,
    description: detail.value.description ?? '',
    issueTypes: detail.value.issueTypes.map((type) => ({
      name: type.name,
      description: type.description ?? '',
      subtask: type.subtask,
      statuses: (statusesByType.get(type.name) ?? []).map((status) => ({
        name: status.name,
        category: status.statusCategory?.name ?? '',
      })),
    })),
    components: components.value.map((component) => ({
      name: component.name,
      description: component.description ?? '',
    })),
  })
}

const toBoardInfo = (board: JiraBoard): JiraBoardInfo => ({
  id: board.id,
  name: board.name,
  type: board.type,
  projectKey: board.location?.projectKey ?? null,
})
