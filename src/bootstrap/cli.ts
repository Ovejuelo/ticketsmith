import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command, Option } from 'commander'
import {
  type CommandDeps,
  type GlobalOptions,
  globalOptions,
  type Io,
  openProject,
  type Runtime,
} from '../core/cli/index.ts'
import { migrateLegacyProfiles } from '../core/project/index.ts'
import type { Services } from '../core/services/index.ts'
import { FEATURES } from './features.ts'
import { openToolSession, startHttpToolServer } from './tool-session.ts'

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
    const session = await openToolSession(current, opened, { version, auditCommand: 'mcp' })
    session.server.server.onclose = () => void session.close()
    process.stdin.once('end', () => void session.close().finally(() => process.exit(0)))
    await session.server.connect(new StdioServerTransport())
  }

  const startAgentToolServer: CommandDeps['startAgentToolServer'] = async (command, options) => {
    const current = servicesFor(command)
    const opened = await openProject(current, globalOptions(command).project)
    return startHttpToolServer(
      await openToolSession(current, opened, {
        version,
        auditCommand: options.auditCommand,
        only: options.only,
        code: options.code,
        tickets: options.tickets,
      }),
    )
  }

  const deps: CommandDeps = {
    io: context.io,
    version,
    runtime: context.runtime,
    servicesFor,
    serveMcp,
    startAgentToolServer,
  }

  const program = new Command('ticketsmith')
    .description(
      'Investigates and resolves tickets with a Claude agent; humans approve side effects. Also available as `tsmith`.',
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
