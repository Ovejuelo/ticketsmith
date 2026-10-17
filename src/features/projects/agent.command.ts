import { Command, Option } from 'commander'
import {
  askSecret,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  parsePositiveInt,
} from '../../core/cli/index.ts'
import {
  AGENT_RUNTIMES,
  type AgentConfig,
  describeProjectError,
  ProjectSchema,
} from '../../core/project/index.ts'
import {
  ANTHROPIC_API_KEY,
  describeSecretError,
  secretEnvVariable,
} from '../../core/secrets/index.ts'

type AgentFlags = {
  readonly runtime?: AgentConfig['runtime']
  readonly model?: string
  readonly budget?: string
  readonly timeout?: number
}

const describe = (agent: AgentConfig): string =>
  [
    `runtime: ${agent.runtime === 'sdk' ? 'sdk (Claude Agent SDK with an API key)' : 'claude-code (your signed-in Claude Code)'}`,
    `model: ${agent.model ?? 'default'}`,
    `budget per run: $${agent.maxBudgetUsd.toFixed(2)}`,
    `time limit: ${agent.timeoutMinutes} min`,
  ].join('\n')

/**
 * `project agent`: shows or changes what runs the agent. Switching to the SDK needs an Anthropic
 * API key, taken from the environment or asked once and kept in the keychain.
 */
export const agentCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('agent')
    .description('Show or change what runs the agent (Claude Code or the Agent SDK) and its limits')
    .addOption(new Option('--runtime <runtime>', 'what runs the agent').choices(AGENT_RUNTIMES))
    .option('--model <model>', 'model alias or name')
    .option('--budget <usd>', 'budget per run in USD')
    .option('--timeout <minutes>', 'time limit per run in minutes', parsePositiveInt)
    .action(async (flags: AgentFlags, command: Command) => {
      const services = servicesFor(command)
      const { project } = await openProject(services, globalOptions(command).project)
      const changed = Object.values(flags).some((value) => value !== undefined)
      if (!changed) {
        io.out(`${describe(project.agent)}\n`)
        return
      }

      const parsed = ProjectSchema.safeParse({
        ...project,
        agent: {
          ...project.agent,
          ...(flags.runtime === undefined ? {} : { runtime: flags.runtime }),
          ...(flags.model === undefined ? {} : { model: flags.model }),
          ...(flags.budget === undefined ? {} : { maxBudgetUsd: Number(flags.budget) }),
          ...(flags.timeout === undefined ? {} : { timeoutMinutes: flags.timeout }),
        },
      })
      if (!parsed.success) fail(`Invalid agent settings: ${parsed.error.issues[0]?.message}`)
      const updated = parsed.data

      if (updated.agent.runtime === 'sdk') {
        const stored = orFail(
          await services.loadSecret(project.name, ANTHROPIC_API_KEY),
          describeSecretError,
        )
        if (stored === null) {
          if (!io.interactive) {
            fail(
              `The Agent SDK needs an Anthropic API key: set ${secretEnvVariable(ANTHROPIC_API_KEY)}, or run this in a terminal to store it in the keychain.`,
            )
          }
          const key = await askSecret('Anthropic API key (stored in the system keychain)')
          orFail(
            await services.saveSecret(project.name, ANTHROPIC_API_KEY, key),
            describeSecretError,
          )
        }
      }
      orFail(await services.projects.save(updated), describeProjectError)
      io.out(`${describe(updated.agent)}\n`)
      if (updated.agent.runtime === 'sdk') {
        io.err(
          'The SDK is an optional dependency: install it next to Ticketsmith (`npm i ticketsmith @anthropic-ai/claude-agent-sdk`) and check with `ticketsmith doctor`.\n',
        )
      }
    })
