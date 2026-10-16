import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command, Option } from 'commander'
import {
  type CommandDeps,
  type GlobalOptions,
  globalOptions,
  type Io,
  openProject,
  type Runtime,
  requireDatabases,
  requireTickets,
} from '../core/cli/index.ts'
import { DATABASE_CATALOG, TableInfoSchema } from '../core/database/index.ts'
import { configuredIntegrations, migrateLegacyProfiles } from '../core/project/index.ts'
import type { Services } from '../core/services/index.ts'
import { describeStorageError, withProjectDatabase } from '../core/storage/index.ts'
import { defaultProjectJql } from '../core/tickets/index.ts'
import { FEATURES } from './features.ts'
import { createMcpServer } from './mcp-server.ts'

export type CliContext = {
  readonly io: Io
  readonly runtime: Runtime
  readonly services: (options: GlobalOptions) => Services
}

/** Builds the `ticketsmith` program from the commands of every feature. */
export const buildProgram = (version: string, context: CliContext): Command => {
  let services: Services | undefined
  const servicesFor = (command: Command): Services => {
    services ??= context.services(globalOptions(command))
    return services
  }

  const serveMcp = async (command: Command): Promise<void> => {
    const current = servicesFor(command)
    const opened = await openProject(current, globalOptions(command).project)
    const { project, paths } = opened
    const tickets = project.integrations.tickets ? await requireTickets(current, opened) : null
    // Adapters open lazily (one pool per database used) and are closed when the client leaves.
    const databases = project.integrations.databases ? requireDatabases(current, opened) : null

    const server = createMcpServer({
      project: project.name,
      tools: FEATURES.flatMap((feature) => feature.tools),
      integrations: configuredIntegrations(project),
      context: {
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
      },
      masking: project.masking,
      audit: current.openAuditLog(project.name, paths, 'mcp'),
      version,
    })

    const closeDatabases = async () => {
      if (databases !== null) await databases[Symbol.asyncDispose]()
    }
    server.server.onclose = () => void closeDatabases()
    process.stdin.once('end', () => void closeDatabases().finally(() => process.exit(0)))
    await server.connect(new StdioServerTransport())
  }

  const deps: CommandDeps = {
    io: context.io,
    version,
    runtime: context.runtime,
    servicesFor,
    serveMcp,
  }

  const program = new Command('ticketsmith')
    .description(
      'Investigates and resolves tickets with a Claude agent; humans approve side effects.',
    )
    .version(version, '-V, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .addOption(new Option('-p, --project <name>', 'project to use').env('TICKETSMITH_PROJECT'))
    .option('--json', 'machine-readable JSON output', false)
    .option('--verbose', 'debug logs on stderr', false)
    .showHelpAfterError()
    // Phase-1 profiles become projects the first time any command runs (notice on stderr only,
    // because stdout may belong to the MCP protocol).
    .hook('preAction', async (_, actionCommand) => {
      const current = servicesFor(actionCommand)
      const report = await migrateLegacyProfiles(current.paths, current.projects)
      for (const name of report.migrated) {
        context.io.err(`Migrated profile "${name}" to project "${name}".\n`)
      }
      for (const failure of report.failed) {
        context.io.err(`Could not migrate ${failure.file}: ${failure.reason}\n`)
      }
    })

  for (const feature of FEATURES) {
    for (const createCommand of feature.commands) program.addCommand(createCommand(deps))
  }
  return program
}
