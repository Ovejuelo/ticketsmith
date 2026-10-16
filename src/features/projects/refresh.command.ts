import { Argument, Command } from 'commander'
import { type CommandDeps, fail, globalOptions, openProject } from '../../core/cli/index.ts'
import { configuredIntegrations, INTEGRATIONS, type Integration } from '../../core/project/index.ts'
import { investigateProject } from './onboarding.ts'
import { printReports } from './project-ui.ts'

export const refreshCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('refresh')
    .description('Investigate again (every configured integration, or one) and rebuild the brief')
    .addArgument(new Argument('[integration]', 'only this integration').choices(INTEGRATIONS))
    .action(async (integration: Integration | undefined, _, command: Command) => {
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      if (
        integration !== undefined &&
        !configuredIntegrations(opened.project).includes(integration)
      ) {
        fail(
          `"${integration}" is not configured. Add it with \`ticketsmith project add ${integration}\`.`,
        )
      }

      const reports = await investigateProject(
        services,
        opened,
        integration === undefined ? undefined : [integration],
      )
      printReports(io, reports)
      io.out(
        reports.length === 0
          ? 'Nothing to investigate; the brief was rebuilt.\n'
          : `Investigated ${reports.length} integration(s); the brief was rebuilt.\n`,
      )
      if (reports.some((report) => report.status !== 'done')) fail('Some investigations failed.')
    })
