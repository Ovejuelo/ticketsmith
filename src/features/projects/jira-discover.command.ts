import { Command } from 'commander'
import { type CommandDeps, globalOptions, parsePositiveInt } from '../../core/cli/index.ts'
import { runDiscover } from './discover-jira.ts'

export const jiraCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('jira').description('JIRA-specific setup').addCommand(
    new Command('discover')
      .description("Choose the JIRA project, board and JQL for this project's ticket source")
      .option('--board <id>', 'board id (from the board URL)', parsePositiveInt)
      .option('--key <key>', 'JIRA project key, when not using a board')
      .option('--fields', 'choose custom fields to include in tickets', false)
      .action(
        async (options: { board?: number; key?: string; fields: boolean }, command: Command) => {
          await runDiscover(servicesFor(command), io, {
            ...options,
            project: globalOptions(command).project,
          })
        },
      ),
  )
