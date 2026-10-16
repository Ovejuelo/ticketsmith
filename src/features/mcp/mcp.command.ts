import { Command } from 'commander'
import { type CommandDeps, globalOptions } from '../../core/cli/index.ts'
import { mcpAddCommand } from './claude-mcp-add.ts'

export const mcpCommand = ({ io, runtime, serveMcp }: CommandDeps): Command =>
  new Command('mcp')
    .description('Run the read-only MCP server over stdio (for Claude Code and other MCP clients)')
    .action(async (_, command: Command) => {
      // stdout belongs to the MCP protocol from here on; logs go to stderr.
      await serveMcp(command)
    })
    .addCommand(
      new Command('setup')
        .description(
          'Print the command that registers this server in Claude Code (does not run it)',
        )
        .action((_, command: Command) => {
          io.out(
            [
              'Register ticketsmith in Claude Code (available in every project):',
              '',
              `  ${mcpAddCommand(runtime, globalOptions(command).project)}`,
              '',
              'Then check it with `claude mcp list` and ask Claude, e.g. "analyze OPS-2403".',
              '',
            ].join('\n'),
          )
        }),
    )
