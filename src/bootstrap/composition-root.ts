import { AgentSdkRuntime } from '../core/agent/providers/agent-sdk/index.ts'
import { ClaudeCodeCliRuntime } from '../core/agent/providers/claude-code/claude-code-cli-runtime.ts'
import { JsonlAuditLog } from '../core/audit/index.ts'
import type { DatabaseAdapter } from '../core/database/index.ts'
import {
  createMysqlConnectionSource,
  MysqlDatabaseAdapter,
} from '../core/database/providers/mysql/index.ts'
import {
  createPostgresConnectionSource,
  PostgresDatabaseAdapter,
} from '../core/database/providers/postgres/index.ts'
import { ConfigError, type Logger } from '../core/kernel/index.ts'
import { MetabaseHttpClient } from '../core/metabase/providers/http/index.ts'
import {
  type DatabaseConfig,
  type JiraCloudSourceConfig,
  ProjectStore,
  resolvePaths,
  type TicketSourceConfig,
} from '../core/project/index.ts'
import { BitbucketCloudPullRequests } from '../core/repos/providers/bitbucket-cloud/bitbucket-pull-requests.ts'
import { GitHubPullRequests } from '../core/repos/providers/github/github-pull-requests.ts'
import { ANTHROPIC_API_KEY, firstAvailable } from '../core/secrets/index.ts'
import { EnvSecretStore } from '../core/secrets/providers/env/env-secret-store.ts'
import { KeyringSecretStore } from '../core/secrets/providers/keyring/keyring-secret-store.ts'
import type { Services, TicketsConnection } from '../core/services/index.ts'
import {
  apiBaseUrl,
  type JiraAuth,
  JiraCloudDiscovery,
  JiraCloudTicketSource,
  JiraCloudTicketWriter,
  JiraHttpClient,
  resolveCloudId,
} from '../core/tickets/providers/jira-cloud/index.ts'
import {
  JiraDataCenterDiscovery,
  JiraDataCenterTicketSource,
  JiraDataCenterTicketWriter,
} from '../core/tickets/providers/jira-data-center/index.ts'

/**
 * The only place that instantiates providers and wires the object graph.
 * Adding a ticket source = one provider folder + one entry in `connectors`.
 */
export type ServicesOptions = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly logger: Logger
}

export const createServices = ({ env, home, logger }: ServicesOptions): Services => {
  const paths = resolvePaths(env, home)
  const keychain = new KeyringSecretStore()
  // Environment first so CI and evals can override the keychain without touching it.
  const secretStores = [new EnvSecretStore(env), keychain]
  const claudeCode = new ClaudeCodeCliRuntime()

  return {
    paths,
    projects: new ProjectStore(paths),
    loadSecret: (project, name) => firstAvailable(secretStores, { project, name }),
    saveSecret: (project, name, value) => keychain.set({ project, name }, value),
    deleteSecret: (project, name) => keychain.delete({ project, name }),
    resolveCloudId: (siteUrl) => resolveCloudId(siteUrl),
    connectTickets: (config, token) =>
      config.type === 'jira-cloud'
        ? connectors['jira-cloud'](config, token, logger)
        : connectors['jira-data-center'](config, token, logger),
    connectDatabase: (config, password) =>
      config.type === 'mysql'
        ? databaseConnectors.mysql(config, password, logger)
        : databaseConnectors.postgres(config, password, logger),
    connectMetabase: (url, apiKey) => new MetabaseHttpClient({ url, apiKey }),
    agentFor: (project) =>
      project.agent.runtime === 'sdk'
        ? new AgentSdkRuntime({
            apiKey: async () => {
              const found = await firstAvailable(secretStores, {
                project: project.name,
                name: ANTHROPIC_API_KEY,
              })
              return found.ok ? (found.value?.value ?? null) : null
            },
          })
        : claudeCode,
    pullRequestHost: (type, apiUrl) =>
      type === 'github'
        ? new GitHubPullRequests({ apiUrl })
        : new BitbucketCloudPullRequests({ apiUrl }),
    openAuditLog: (project, location, command) =>
      new JsonlAuditLog({
        dir: location.auditDir,
        command,
        project,
        onError: (error) => logger.warn({ error: String(error) }, 'audit write failed'),
      }),
  }
}

type Connector<T extends TicketSourceConfig['type']> = (
  config: Extract<TicketSourceConfig, { type: T }>,
  token: string,
  logger: Logger,
) => TicketsConnection

const jiraAuth = (config: JiraCloudSourceConfig): JiraAuth => {
  if (config.auth === 'classic') return { kind: 'classic', siteUrl: config.siteUrl }
  if (config.cloudId === undefined) {
    throw new ConfigError('Scoped JIRA tokens need a cloudId; run `ticketsmith init` again.')
  }
  return { kind: 'scoped', cloudId: config.cloudId }
}

const connectors: { readonly [T in TicketSourceConfig['type']]: Connector<T> } = {
  'jira-cloud': (config, token, logger) => {
    const client = new JiraHttpClient({
      baseUrl: apiBaseUrl(jiraAuth(config)),
      email: config.email,
      token,
      logger,
    })
    return {
      source: new JiraCloudTicketSource(client, {
        siteUrl: config.siteUrl,
        customFields: config.customFields,
      }),
      discovery: new JiraCloudDiscovery(client),
      writer: config.allowWrites ? new JiraCloudTicketWriter(client, config.siteUrl) : null,
    }
  },
  'jira-data-center': (config, token, logger) => {
    // No email: the personal access token goes as a Bearer token.
    const client = new JiraHttpClient({ baseUrl: config.siteUrl, token, logger })
    return {
      source: new JiraDataCenterTicketSource(client, {
        siteUrl: config.siteUrl,
        customFields: config.customFields,
      }),
      discovery: new JiraDataCenterDiscovery(client),
      writer: config.allowWrites ? new JiraDataCenterTicketWriter(client, config.siteUrl) : null,
    }
  },
}

type DatabaseConnector<T extends DatabaseConfig['type']> = (
  config: Extract<DatabaseConfig, { type: T }>,
  password: string,
  logger: Logger,
) => DatabaseAdapter

/** Adding a database engine = one provider folder + one entry here. */
const databaseConnectors: { readonly [T in DatabaseConfig['type']]: DatabaseConnector<T> } = {
  mysql: (config, password, logger) =>
    new MysqlDatabaseAdapter({
      name: config.name,
      source: createMysqlConnectionSource({ ...config, password }),
      logger,
    }),
  postgres: (config, password, logger) =>
    new PostgresDatabaseAdapter({
      name: config.name,
      schema: config.schema,
      source: createPostgresConnectionSource({ ...config, password }),
      logger,
    }),
}
