import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AuditLog } from '../core/audit/index.ts'
import {
  type AgentToolServer,
  type OpenedProject,
  requireDatabases,
  requireTickets,
} from '../core/cli/index.ts'
import { DATABASE_CATALOG, TableInfoSchema } from '../core/database/index.ts'
import type { ToolContext } from '../core/mcp/index.ts'
import { configuredIntegrations } from '../core/project/index.ts'
import { projectRepositories } from '../core/repos/index.ts'
import { PlaceholderVault } from '../core/security/index.ts'
import type { Services } from '../core/services/index.ts'
import { describeStorageError, withProjectDatabase } from '../core/storage/index.ts'
import { defaultProjectJql } from '../core/tickets/index.ts'
import { FEATURES } from './features.ts'
import { createMcpServer } from './mcp-server.ts'

export type ToolSessionOptions = {
  readonly version: string
  readonly auditCommand: string
  readonly only?: ((toolName: string) => boolean) | undefined
}

/** One MCP server over the project's tools, with its vault, audit and lazily opened databases. */
export type ToolSession = {
  readonly server: McpServer
  readonly vault: PlaceholderVault
  readonly audit: AuditLog
  toolCalls(): Readonly<Record<string, number>>
  close(): Promise<void>
}

/** Builds what every tool can use for this project: only the integrations it has configured. */
export const openToolSession = async (
  services: Services,
  opened: OpenedProject,
  options: ToolSessionOptions,
): Promise<ToolSession> => {
  const { project, paths } = opened
  const tickets = project.integrations.tickets ? await requireTickets(services, opened) : null
  // Adapters open lazily (one pool per database used) and are closed with the session.
  const databases = project.integrations.databases ? requireDatabases(services, opened) : null

  const context: Omit<ToolContext, 'resolvePlaceholders'> = {
    tickets:
      tickets === null
        ? null
        : {
            source: tickets.source,
            defaultJql:
              tickets.config.jql ??
              (tickets.config.projectKey === undefined
                ? undefined
                : defaultProjectJql(tickets.config.projectKey)),
          },
    databases:
      databases === null
        ? null
        : {
            connections: databases,
            changes: { dir: paths.changesDir, maxRows: project.changes.maxRows },
            tables: async (target) => {
              const read = await withProjectDatabase(paths.sqlite, (db) =>
                db.catalog(
                  DATABASE_CATALOG.integration,
                  DATABASE_CATALOG.tableKind(target),
                  TableInfoSchema,
                ),
              )
              if (!read.ok) return { ok: false, error: describeStorageError(read.error) }
              return read.value.ok
                ? { ok: true, value: read.value.value.map((entry) => entry.data) }
                : { ok: false, error: describeStorageError(read.value.error) }
            },
          },
    repos:
      project.integrations.repos === undefined
        ? null
        : { repositories: projectRepositories(project, paths), knowledgeDir: paths.knowledgeDir },
    knowledge: { dir: paths.knowledgeDir },
  }

  const calls: Record<string, number> = {}
  const inner = services.openAuditLog(project.name, paths, options.auditCommand)
  const audit: AuditLog = {
    record: (entry) => {
      calls[entry.tool] = (calls[entry.tool] ?? 0) + 1
      return inner.record(entry)
    },
  }
  const vault = new PlaceholderVault()
  const only = options.only
  const server = createMcpServer({
    project: project.name,
    tools: FEATURES.flatMap((feature) => feature.tools).filter(
      (tool) => only === undefined || only(tool.name),
    ),
    integrations: configuredIntegrations(project),
    context,
    masking: project.masking,
    audit,
    version: options.version,
    vault,
  })
  return {
    server,
    vault,
    audit,
    toolCalls: () => ({ ...calls }),
    close: async () => {
      if (databases !== null) await databases[Symbol.asyncDispose]()
    },
  }
}

const sameSecret = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Serves a tool session to one local agent over Streamable HTTP: 127.0.0.1 only, a random port,
 * a random bearer token per run and DNS-rebinding protection. The vault stays in this process, so
 * the agent's answer can be revealed for local files once the run ends.
 */
export const startHttpToolServer = async (session: ToolSession): Promise<AgentToolServer> => {
  const token = randomBytes(32).toString('hex')
  let transport: StreamableHTTPServerTransport | undefined

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    if (!sameSecret(request.headers.authorization, `Bearer ${token}`) || transport === undefined) {
      response.writeHead(401).end()
      return
    }
    transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`],
  })
  // The SDK's transport class predates exactOptionalPropertyTypes; it is a Transport at runtime.
  await session.server.connect(transport as Transport)

  return {
    mcpConfig: {
      mcpServers: {
        ticketsmith: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    reveal: (text) => session.vault.reveal(text),
    toolCalls: session.toolCalls,
    record: (entry) => session.audit.record(entry),
    close: async () => {
      await session.server.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      await session.close()
    },
  }
}
