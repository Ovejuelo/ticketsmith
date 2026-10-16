import { Argument, Command, Option } from 'commander'
import {
  askConfirm,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  parsePositiveInt,
} from '../../core/cli/index.ts'
import { removeKnowledge } from '../../core/knowledge/index.ts'
import {
  describeProjectError,
  INTEGRATIONS,
  type Integration,
  JiraAuthKindSchema,
  type Project,
} from '../../core/project/index.ts'
import { databaseSecret, describeSecretError, type SecretName } from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'
import { describeStorageError, withProjectDatabase } from '../../core/storage/index.ts'
import {
  addDatabaseFromFlags,
  configureDatabasesInteractively,
  type DatabaseFlags,
} from './database-setup.ts'
import { investigateProject } from './onboarding.ts'
import { openByName, printReports } from './project-ui.ts'
import {
  addTicketSourceFromFlags,
  configureTicketSourceInteractively,
  type JiraFlags,
} from './ticket-source-setup.ts'

const integrationArgument = () =>
  new Argument('<integration>', 'integration to change').choices(INTEGRATIONS)

/** Where each integration keeps its knowledge, removed together with the integration. */
const KNOWLEDGE_DIRS: Readonly<Record<Integration, string>> = {
  tickets: 'tickets',
  databases: 'databases',
}

/** The keychain entries an integration owns in a project. */
const secretsOf = (project: Project, integration: Integration): readonly SecretName[] =>
  integration === 'tickets'
    ? ['jira-token']
    : (project.integrations.databases ?? []).map((database) => databaseSecret(database.name))

type AddFlags = JiraFlags & DatabaseFlags

export const addCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('add')
    .description('Add (or reconfigure) an integration, then investigate it')
    .addArgument(integrationArgument())
    .option('--site <url>', 'tickets: JIRA site (non-interactive)')
    .option('--email <email>', 'tickets: Atlassian account email (non-interactive)')
    .addOption(
      new Option('--auth <kind>', 'tickets: JIRA token type').choices(JiraAuthKindSchema.options),
    )
    .option('--name <name>', 'databases: name in this project, e.g. shard1 (non-interactive)')
    .option('--host <host>', 'databases: host')
    .option('--port <port>', 'databases: port (default 3306)', parsePositiveInt)
    .option('--database <schema>', 'databases: database (schema) name')
    .option('--user <user>', 'databases: user')
    .option('--group <group>', 'databases: group of databases sharing a schema')
    .option('--ssl', 'databases: connect with TLS')
    .action(async (integration: Integration, flags: AddFlags, command: Command) => {
      const services = servicesFor(command)
      const { project } = await openProject(services, globalOptions(command).project)

      let updated: Project
      if (integration === 'tickets') {
        updated = io.interactive
          ? (await configureTicketSourceInteractively(services, io, project)).project
          : await addTicketSourceFromFlags(services, project, flags)
      } else {
        updated = io.interactive
          ? (await configureDatabasesInteractively(services, project)).project
          : await addDatabaseFromFlags(services, io, project, flags)
      }

      const reports = await investigateProject(services, await openByName(services, updated.name), [
        integration,
      ])
      printReports(io, reports)
      io.out(`${integration} ready in project "${updated.name}".\n`)
    })

export const removeCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('remove')
    .description(
      'Remove an integration (or one database): config, stored secrets, catalog and knowledge',
    )
    .addArgument(integrationArgument())
    .option('--db <name>', 'databases: remove only this database')
    .option('--yes', 'do not ask for confirmation', false)
    .action(
      async (
        integration: Integration,
        options: { yes: boolean; db?: string },
        command: Command,
      ) => {
        const services = servicesFor(command)
        const opened = await openProject(services, globalOptions(command).project)
        const { project, paths } = opened
        if (project.integrations[integration] === undefined) {
          fail(`"${integration}" is not configured in project "${project.name}".`)
        }
        const what = options.db === undefined ? integration : `database "${options.db}"`
        if (!options.yes) {
          if (!io.interactive) fail('Pass --yes to remove it without a terminal.')
          const confirmed = await askConfirm(`Remove ${what} from "${project.name}"?`, false)
          if (!confirmed) fail('Nothing removed.')
        }

        if (integration === 'databases' && options.db !== undefined) {
          await removeOneDatabase(services, project, options.db)
          io.out(
            `Removed ${what}. Run \`ticketsmith project refresh databases\` to update its knowledge.\n`,
          )
          return
        }

        const { [integration]: _removed, ...remaining } = project.integrations
        const updated = { ...project, integrations: remaining }
        orFail(await services.projects.save(updated), describeProjectError)
        for (const secret of secretsOf(project, integration)) {
          orFail(await services.deleteSecret(project.name, secret), describeSecretError)
        }
        orFail(
          await withProjectDatabase(paths.sqlite, (db) => {
            db.clearCatalog(integration)
            db.removeSteps(integration)
          }),
          describeStorageError,
        )
        orFail(
          await removeKnowledge(paths.knowledgeDir, KNOWLEDGE_DIRS[integration]),
          (e) => e.message,
        )
        await investigateProject(services, { project: updated, paths }) // rebuilds the brief
        io.out(`Removed ${what} from project "${project.name}".\n`)
      },
    )

const removeOneDatabase = async (
  services: Services,
  project: Project,
  name: string,
): Promise<void> => {
  const databases = project.integrations.databases ?? []
  if (!databases.some((database) => database.name === name)) {
    fail(
      `Database "${name}" is not configured. Configured: ${databases.map((d) => d.name).join(', ')}.`,
    )
  }
  const remainingDatabases = databases.filter((database) => database.name !== name)
  const { databases: _all, ...others } = project.integrations
  const updated = {
    ...project,
    integrations:
      remainingDatabases.length > 0 ? { ...others, databases: remainingDatabases } : others,
  }
  orFail(await services.projects.save(updated), describeProjectError)
  orFail(await services.deleteSecret(project.name, databaseSecret(name)), describeSecretError)
}
