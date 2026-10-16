import { Command } from 'commander'
import { type CommandDeps, orFail } from '../../core/cli/index.ts'
import { describeProjectError } from '../../core/project/index.ts'
import { describeSecretError } from '../../core/secrets/index.ts'
import { investigateProject } from './onboarding.ts'
import { openByName } from './project-ui.ts'

export const renameCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('rename')
    .description('Rename a project: folder, project.yaml, active project and keychain entries')
    .argument('<from>', 'current name')
    .argument('<to>', 'new name')
    .action(async (from: string, to: string, _, command: Command) => {
      const services = servicesFor(command)
      // Read the secret before renaming: keychain entries are keyed by project name.
      const token = orFail(await services.loadSecret(from, 'jira-token'), describeSecretError)

      orFail(await services.projects.rename(from, to), describeProjectError)

      // Only keychain secrets move; environment variables are not tied to a project name.
      if (token !== null && token.source === 'keychain') {
        orFail(await services.saveSecret(to, 'jira-token', token.value), describeSecretError)
        orFail(await services.deleteSecret(from, 'jira-token'), describeSecretError)
      }
      await investigateProject(services, await openByName(services, to), []) // rebuilds the brief
      io.out(`Renamed project "${from}" to "${to}".\n`)
    })
