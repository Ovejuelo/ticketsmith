import type { AgentRuntime } from '../agent/index.ts'
import type { AuditLog } from '../audit/index.ts'
import type { DatabaseAdapter } from '../database/index.ts'
import type { Result } from '../kernel/index.ts'
import type {
  DatabaseConfig,
  Paths,
  ProjectPaths,
  ProjectStore,
  TicketSourceConfig,
} from '../project/index.ts'
import type { FoundSecret, SecretName, SecretStoreError } from '../secrets/index.ts'
import type { JiraDiscovery, TicketSource, TicketSourceError } from '../tickets/index.ts'

/** A connected ticket source; only sources with a setup API (JIRA) provide discovery. */
export type TicketsConnection = {
  readonly source: TicketSource
  readonly discovery: JiraDiscovery | null
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
  /** The agent that runs playbooks (Claude Code headless in v1). */
  readonly agent: AgentRuntime
  /** One audit file per run in the project's local/audit folder. */
  openAuditLog(project: string, location: ProjectPaths, command: string): AuditLog
}
