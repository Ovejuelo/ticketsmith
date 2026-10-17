import type { AgentRuntime } from '../agent/index.ts'
import type { AuditLog } from '../audit/index.ts'
import type { DatabaseAdapter } from '../database/index.ts'
import type { Result } from '../kernel/index.ts'
import type { MetabaseClient } from '../metabase/index.ts'
import type {
  DatabaseConfig,
  Paths,
  Project,
  ProjectPaths,
  ProjectStore,
  TicketSourceConfig,
} from '../project/index.ts'
import type { HostType, PullRequestHost } from '../repos/index.ts'
import type { FoundSecret, SecretName, SecretStoreError } from '../secrets/index.ts'
import type {
  JiraDiscovery,
  TicketSource,
  TicketSourceError,
  TicketWriter,
} from '../tickets/index.ts'

/** A connected ticket source; only sources with a setup API (JIRA) provide discovery. */
export type TicketsConnection = {
  readonly source: TicketSource
  readonly discovery: JiraDiscovery | null
  /** Only when the project allows writes (allowWrites); used by the CLI after a confirmation. */
  readonly writer: TicketWriter | null
}

/** What features need from the outside world; implemented in bootstrap/composition-root.ts. */
export interface Services {
  readonly paths: Paths
  readonly projects: ProjectStore
  loadSecret(
    project: string,
    name: SecretName,
  ): Promise<Result<FoundSecret | null, SecretStoreError>>
  saveSecret(
    project: string,
    name: SecretName,
    value: string,
  ): Promise<Result<void, SecretStoreError>>
  deleteSecret(project: string, name: SecretName): Promise<Result<void, SecretStoreError>>
  resolveCloudId(siteUrl: string): Promise<Result<string, TicketSourceError>>
  connectTickets(config: TicketSourceConfig, token: string): TicketsConnection
  /** A new adapter (its own small pool); dispose it when done. */
  connectDatabase(config: DatabaseConfig, password: string): DatabaseAdapter
  /** Opens pull requests on a host type (GitHub, Bitbucket Cloud); `apiUrl` for self-hosted ones. */
  pullRequestHost(type: Exclude<HostType, 'none'>, apiUrl: string | undefined): PullRequestHost
  /** A Metabase API client for the project's Metabase site. */
  connectMetabase(url: string, apiKey: string): MetabaseClient
  /** The agent that runs the project's playbooks, from its `agent.runtime`. */
  agentFor(project: Project): AgentRuntime
  /** One audit file per run in the project's local/audit folder. */
  openAuditLog(project: string, location: ProjectPaths, command: string): AuditLog
}
