import { Argument, Command } from 'commander'
import { type CommandDeps, fail, globalOptions, openProject, orFail } from '../../core/cli/index.ts'
import { configuredIntegrations, INTEGRATIONS, type Integration } from '../../core/project/index.ts'
import { describeStorageError, withProjectDatabase } from '../../core/storage/index.ts'
import { investigateProject } from './onboarding.ts'
import { printReports } from './project-ui.ts'
import { analyzeRepositories } from './repo-analysis.ts'

type RefreshFlags = { readonly deep: boolean; readonly force: boolean; readonly repo?: string[] }

/** The deep analysis only needs to read code and knowledge. */
const ANALYSIS_TOOLS = (name: string): boolean =>
  name.startsWith('repo_') || name.startsWith('knowledge_')

export const refreshCommand = ({ io, servicesFor, startAgentToolServer }: CommandDeps): Command =>
  new Command('refresh')
    .description('Investigate again (every configured integration, or one) and rebuild the brief')
    .addArgument(new Argument('[integration]', 'only this integration').choices(INTEGRATIONS))
    .option('--deep', 'repos: also have the agent analyze each repository (costs tokens)', false)
    .option('--repo <names...>', 'repos: only these repositories for --deep')
    .option('--force', 'repos: analyze again even if the commit did not move', false)
    .action(async (integration: Integration | undefined, flags: RefreshFlags, command: Command) => {
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      if (flags.deep && opened.project.integrations.repos === undefined) {
        fail(
          '--deep analyzes repositories, and this project has none (`ticketsmith project add repos`).',
        )
      }
      if (flags.deep && integration !== undefined && integration !== 'repos') {
        fail('--deep only applies to repos.')
      }
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
      if (flags.deep) {
        io.err('Analyzing repositories with Claude (this takes a few minutes per repository)…\n')
        const analyses = orFail(
          await withProjectDatabase(opened.paths.sqlite, (db) =>
            analyzeRepositories(
              services,
              opened,
              db,
              () =>
                startAgentToolServer(command, { auditCommand: 'refresh', only: ANALYSIS_TOOLS }),
              { only: flags.repo, force: flags.force },
            ),
          ),
          describeStorageError,
        )
        for (const report of analyses) {
          io.err(
            `${report.status === 'failed' ? '!' : '✔'} ${report.repo} analysis: ${report.status} (${report.detail})\n`,
          )
        }
        if (analyses.some((report) => report.status === 'failed')) fail('Some analyses failed.')
      }
      io.out(
        reports.length === 0
          ? 'Nothing to investigate; the brief was rebuilt.\n'
          : `Investigated ${reports.length} integration(s); the brief was rebuilt.\n`,
      )
      if (reports.some((report) => report.status !== 'done')) fail('Some investigations failed.')
    })
