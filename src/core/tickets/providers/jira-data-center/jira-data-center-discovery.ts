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
  JiraBoardConfigurationSchema,
  JiraFieldListSchema,
  JiraFilterSchema,
  JiraProjectListSchema,
} from '../jira-cloud/jira-api.schemas.ts'
import { JiraCloudDiscovery, projectOverview } from '../jira-cloud/jira-cloud-discovery.ts'
import type { JiraHttpClient } from '../jira-cloud/jira-http-client.ts'

const API = '/rest/api/2'

/**
 * Discovery on Data Center: projects, filters and fields through API v2; boards through the agile
 * API, which has the same shape as on Cloud.
 */
export class JiraDataCenterDiscovery implements JiraDiscovery {
  readonly #client: JiraHttpClient
  readonly #agile: JiraCloudDiscovery

  constructor(client: JiraHttpClient) {
    this.#client = client
    this.#agile = new JiraCloudDiscovery(client)
  }

  async listProjects(): Promise<Result<readonly JiraProjectInfo[], TicketSourceError>> {
    const result = await this.#client.get(`${API}/project`, {}, JiraProjectListSchema)
    if (!result.ok) return result
    return ok(
      result.value
        .map(({ key, name }) => ({ key, name }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    )
  }

  listBoards(projectKey?: string): Promise<Result<readonly JiraBoardInfo[], TicketSourceError>> {
    return this.#agile.listBoards(projectKey)
  }

  getBoard(boardId: number): Promise<Result<JiraBoardInfo, TicketSourceError>> {
    return this.#agile.getBoard(boardId)
  }

  async getBoardFilterJql(boardId: number): Promise<Result<string, TicketSourceError>> {
    const config = await this.#client.get(
      `/rest/agile/1.0/board/${boardId}/configuration`,
      {},
      JiraBoardConfigurationSchema,
    )
    if (!config.ok) return config
    const filter = await this.#client.get(
      `${API}/filter/${encodeURIComponent(config.value.filter.id)}`,
      {},
      JiraFilterSchema,
    )
    return filter.ok ? ok(filter.value.jql) : filter
  }

  getProjectOverview(projectKey: string): Promise<Result<JiraProjectOverview, TicketSourceError>> {
    return projectOverview(this.#client, projectKey, API)
  }

  async listCustomFields(): Promise<Result<readonly JiraFieldInfo[], TicketSourceError>> {
    const result = await this.#client.get(`${API}/field`, {}, JiraFieldListSchema)
    if (!result.ok) return result
    return ok(
      result.value
        .filter((field) => field.custom)
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  }
}
