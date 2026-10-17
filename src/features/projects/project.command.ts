import { Command } from 'commander'
import { type CommandDeps, globalOptions, orFail } from '../../core/cli/index.ts'
import { configuredIntegrations, describeProjectError } from '../../core/project/index.ts'
import { describeSecretError } from '../../core/secrets/index.ts'
import { agentCommand } from './agent.command.ts'
import { initCommand } from './init.command.ts'
import { addCommand, removeCommand } from './integration.command.ts'
import { refreshCommand } from './refresh.command.ts'
import { renameCommand } from './rename.command.ts'
import { exportCommand, importCommand, linkCommand } from './share.command.ts'
import { statusCommand } from './status.command.ts'

export const projectCommand = (deps: CommandDeps): Command => {
  const { io, servicesFor } = deps
  return new Command('project')
    .description('Create, inspect and switch projects')
    .addCommand(initCommand(deps))
    .addCommand(statusCommand(deps))
    .addCommand(refreshCommand(deps))
    .addCommand(addCommand(deps))
    .addCommand(removeCommand(deps))
    .addCommand(agentCommand(deps))
    .addCommand(
      new Command('list')
        .description('List projects (* = active)')
        .action(async (_, command: Command) => {
          const { projects } = servicesFor(command)
          const names = orFail(await projects.list(), describeProjectError)
          const active = await projects.resolveProjectName(undefined)
          const activeName = active.ok ? active.value : null

          if (globalOptions(command).json) {
            io.out(
              `${JSON.stringify(
                names.map((name) => ({ name, active: name === activeName })),
                null,
                2,
              )}\n`,
            )
          } else if (names.length === 0) {
            io.out('No projects yet. Run `ticketsmith project init`.\n')
          } else {
            io.out(
              `${names.map((name) => `${name === activeName ? '*' : ' '} ${name}`).join('\n')}\n`,
            )
          }
        }),
    )
    .addCommand(
      new Command('use')
        .description('Set the active project')
        .argument('<name>', 'project name')
        .action(async (name: string, _, command: Command) => {
          const { projects } = servicesFor(command)
          orFail(await projects.load(name), describeProjectError)
          orFail(await projects.setActiveProject(name), describeProjectError)
          io.out(`Active project: ${name}\n`)
        }),
    )
    .addCommand(
      new Command('show')
        .description('Show a project (defaults to the active one); never prints secrets')
        .argument('[name]', 'project name')
        .action(async (name: string | undefined, _, command: Command) => {
          const services = servicesFor(command)
          const resolved = orFail(
            await services.projects.resolveProjectName(name ?? globalOptions(command).project),
            describeProjectError,
          )
          const project = orFail(await services.projects.load(resolved), describeProjectError)
          const location = orFail(await services.projects.locate(resolved), describeProjectError)
          const token = project.integrations.tickets
            ? orFail(await services.loadSecret(resolved, 'jira-token'), describeSecretError)
            : null
          const view = {
            ...project,
            folder: location.root,
            integrations: configuredIntegrations(project),
            config: project.integrations,
            secrets: project.integrations.tickets
              ? { 'jira-token': token === null ? 'missing' : `stored in ${token.source}` }
              : {},
          }
          io.out(`${JSON.stringify(view, null, 2)}\n`)
        }),
    )
    .addCommand(renameCommand(deps))
    .addCommand(linkCommand(deps))
    .addCommand(exportCommand(deps))
    .addCommand(importCommand(deps))
}
