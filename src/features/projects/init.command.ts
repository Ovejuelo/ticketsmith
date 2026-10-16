import { Command, Option } from 'commander'
import {
  askConfirm,
  askText,
  type CommandDeps,
  fail,
  globalOptions,
  intro,
  log,
  orFail,
  outro,
  spinner,
} from '../../core/cli/index.ts'
import {
  describeProjectError,
  type Integration,
  JiraAuthKindSchema,
  ProjectNameSchema,
} from '../../core/project/index.ts'
import { configureDatabasesInteractively } from './database-setup.ts'
import { initGitRepository, isGitRepository } from './git-repository.ts'
import { validateWith } from './jira-prompts.ts'
import { BRIEF_FILE, investigateProject, pendingInvestigations } from './onboarding.ts'
import { loadOrCreate, openByName, printReports } from './project-ui.ts'
import { configureReposInteractively } from './repo-setup.ts'
import {
  addTicketSourceFromFlags,
  configureTicketSourceInteractively,
  type JiraFlags,
} from './ticket-source-setup.ts'

type InitOptions = JiraFlags & { readonly name?: string }

export const initCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('init')
    .description('Create or update a project: configure, verify and investigate its integrations')
    .option('--name <project>', 'project name')
    .option('--site <url>', 'JIRA site, e.g. acme.atlassian.net (adds a ticket source)')
    .option('--email <email>', 'Atlassian account email')
    .addOption(new Option('--auth <kind>', 'JIRA token type').choices(JiraAuthKindSchema.options))
    .action(async (options: InitOptions, command: Command) => {
      const services = servicesFor(command)
      const explicitName = options.name ?? globalOptions(command).project

      if (!io.interactive) {
        // Scripted setup: flags only; a ticket source is added when --site is given.
        if (!explicitName) fail('Non-interactive init needs --name.')
        const invalidName = validateWith(ProjectNameSchema)(explicitName)
        if (invalidName !== undefined) fail(`Invalid project name: ${invalidName}`)
        let project = await loadOrCreate(services, explicitName)
        if (options.site !== undefined) {
          project = await addTicketSourceFromFlags(services, project, options)
        } else {
          orFail(await services.projects.save(project), describeProjectError)
        }
        orFail(await services.projects.setActiveProject(project.name), describeProjectError)
        printReports(
          io,
          await investigateProject(services, await openByName(services, project.name)),
        )
        io.out(`Project "${project.name}" is active.\n`)
        return
      }

      intro('ticketsmith project init')
      const active = await services.projects.resolveProjectName(undefined)
      const name = await askText({
        message: 'Project name',
        placeholder: 'billing',
        initialValue: explicitName ?? (active.ok ? active.value : ''),
        validate: validateWith(ProjectNameSchema),
      })
      let project = await loadOrCreate(services, name)
      const reconfigured: Integration[] = []

      if (await askConfirm('Use a ticket source (JIRA Cloud)?', true)) {
        const result = await configureTicketSourceInteractively(services, io, project)
        project = result.project
        if (result.changed) reconfigured.push('tickets')
      } else {
        orFail(await services.projects.save(project), describeProjectError)
      }
      if (await askConfirm('Use databases?', project.integrations.databases !== undefined)) {
        const result = await configureDatabasesInteractively(services, project)
        project = result.project
        if (result.changed) reconfigured.push('databases')
      }
      if (await askConfirm('Use git repositories?', project.integrations.repos !== undefined)) {
        const paths = orFail(await services.projects.locate(project.name), describeProjectError)
        const result = await configureReposInteractively(services, project, paths)
        project = result.project
        if (result.changed) reconfigured.push('repos')
      }

      orFail(await services.projects.setActiveProject(project.name), describeProjectError)
      const opened = await openByName(services, project.name)

      // Resume what failed or never ran, plus whatever was (re)configured just now.
      const toInvestigate = [
        ...new Set([...(await pendingInvestigations(opened)), ...reconfigured]),
      ]
      if (toInvestigate.length > 0) {
        const progress = spinner()
        progress.start(`Investigating ${toInvestigate.join(', ')}`)
        const reports = await investigateProject(services, opened, toInvestigate)
        progress.stop('Investigation finished')
        printReports(io, reports)
      }

      if (
        !isGitRepository(opened.paths.root) &&
        (await askConfirm('Make the project folder a git repository (to share it later)?', true))
      ) {
        const initialized = await initGitRepository(opened.paths.root)
        if (initialized.ok) log.success('git repository created')
        else log.warn(`git init failed: ${initialized.error}`)
      }
      outro(
        [
          `Project "${project.name}" is ready and active.`,
          `Folder: ${opened.paths.root}`,
          `Brief:  ${opened.paths.knowledgeDir}/${BRIEF_FILE}`,
        ].join('\n'),
      )
    })
