import { rm } from 'node:fs/promises'
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
  type ProjectPaths,
} from '../../core/project/index.ts'
import { cloneDir } from '../../core/repos/index.ts'
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
  addRepositoryFromFlags,
  configureReposInteractively,
  type RepoFlags,
} from './repo-setup.ts'
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
  repos: 'repos',
}

/** The keychain entries an integration owns in a project. */
const secretsOf = (project: Project, integration: Integration): readonly SecretName[] => {
  if (integration === 'tickets') return ['jira-token']
  if (integration === 'databases') {
    return (project.integrations.databases ?? []).map((database) => databaseSecret(database.name))
  }
  return [] // repositories use the user's own git credentials
}

type AddFlags = JiraFlags & DatabaseFlags & RepoFlags

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
    .option(
      '--allow-changes',
      'databases: let the agent propose changes you approve (db_propose_change)',
    )
    .option('--url <url>', 'repos: clone URL, ssh or https (non-interactive)')
    .option('--fix-branch <branch>', 'repos: base branch for fixes (default: the remote default)')
    .option(
      '--feature-branch <branch>',
      'repos: base branch for features (default: the remote default)',
    )
    .option('--protected <branches>', 'repos: comma-separated protected branches')
    .option('--node <version>', 'repos: Node version (default: detected)')
    .option('--test-command <command>', 'repos: test command (default: detected)')
    .option(
      '--allow-code-changes',
      'repos: let the agent change code in ticket worktrees (ticketsmith code)',
    )
    .option('--branch-pattern <pattern>', 'repos: ticket branch name, e.g. hotfix/{key}-{slug}')
    .option('--pr-target <branch>', 'repos: pull request target (default: the fix branch)')
    .action(async (integration: Integration, flags: AddFlags, command: Command) => {
      const services = servicesFor(command)
      const { project, paths } = await openProject(services, globalOptions(command).project)

      let updated: Project
      if (integration === 'tickets') {
        updated = io.interactive
          ? (await configureTicketSourceInteractively(services, io, project)).project
          : await addTicketSourceFromFlags(services, project, flags)
      } else if (integration === 'databases') {
        updated = io.interactive
          ? (await configureDatabasesInteractively(services, project)).project
          : await addDatabaseFromFlags(services, io, project, flags)
      } else {
        updated = io.interactive
          ? (await configureReposInteractively(services, project, paths)).project
          : await addRepositoryFromFlags(services, project, paths, flags)
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
      'Remove an integration (or one database or repository): config, stored secrets, clones, catalog and knowledge',
    )
    .addArgument(integrationArgument())
    .option('--db <name>', 'databases: remove only this database')
    .option('--repo <name>', 'repos: remove only this repository')
    .option('--yes', 'do not ask for confirmation', false)
    .action(
      async (
        integration: Integration,
        options: { yes: boolean; db?: string; repo?: string },
        command: Command,
      ) => {
        const services = servicesFor(command)
        const opened = await openProject(services, globalOptions(command).project)
        const { project, paths } = opened
        if (project.integrations[integration] === undefined) {
          fail(`"${integration}" is not configured in project "${project.name}".`)
        }
        const what =
          options.db !== undefined
            ? `database "${options.db}"`
            : options.repo !== undefined
              ? `repository "${options.repo}"`
              : integration
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
        if (integration === 'repos' && options.repo !== undefined) {
          await removeOneRepository(services, project, paths, options.repo)
          io.out(
            `Removed ${what}. Run \`ticketsmith project refresh repos\` to update its knowledge.\n`,
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
        if (integration === 'repos') await rm(paths.reposDir, { recursive: true, force: true })
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

const removeOneRepository = async (
  services: Services,
  project: Project,
  paths: ProjectPaths,
  name: string,
): Promise<void> => {
  const repos = project.integrations.repos ?? []
  if (!repos.some((repo) => repo.name === name)) {
    fail(
      `Repository "${name}" is not configured. Configured: ${repos.map((r) => r.name).join(', ')}.`,
    )
  }
  const remaining = repos.filter((repo) => repo.name !== name)
  const { repos: _all, ...others } = project.integrations
  const updated = {
    ...project,
    integrations: remaining.length > 0 ? { ...others, repos: remaining } : others,
  }
  orFail(await services.projects.save(updated), describeProjectError)
  await rm(cloneDir(paths, name), { recursive: true, force: true })
}
