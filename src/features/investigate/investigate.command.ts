import { Command } from 'commander'
import { type CommandDeps, fail, globalOptions, openProject, orFail } from '../../core/cli/index.ts'
import { severityCounts } from './render-investigation.ts'
import { INVESTIGATE_TOOLS, runInvestigation } from './run-investigation.ts'

type InvestigateFlags = {
  readonly playbook: string
  readonly model?: string
  readonly budget?: number
}

const MAX_QUESTION = 2000

const parseBudget = (value: string): number => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
    fail(`Invalid --budget "${value}": a number of US dollars between 0 and 100.`)
  }
  return amount
}

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const investigateCommand = ({
  io,
  servicesFor,
  startAgentToolServer,
}: CommandDeps): Command =>
  new Command('investigate')
    .description(
      'Investigate a question without a ticket (a feature, a flow, the data) and write analysis.md',
    )
    .argument('<question...>', 'what to investigate, e.g. "review how accounts are deactivated"')
    .option(
      '--playbook <name>',
      'playbook: knowledge/playbooks/<name>.md or built-in',
      'investigate',
    )
    .option('--model <model>', 'Claude model (default: agent.model or your Claude Code default)')
    .option('--budget <usd>', 'maximum spend for this run, in US dollars', parseBudget)
    .action(async (words: string[], flags: InvestigateFlags, command: Command) => {
      const question = words.join(' ').trim()
      if (question === '') fail('Give a question to investigate.')
      if (question.length > MAX_QUESTION) {
        fail(`The question is too long (${question.length} characters, at most ${MAX_QUESTION}).`)
      }
      const global = globalOptions(command)
      const services = servicesFor(command)
      const opened = await openProject(services, global.project)
      const { tickets, databases, repos } = opened.project.integrations
      if (tickets === undefined && databases === undefined && repos === undefined) {
        fail(
          `Project "${opened.project.name}" has nothing to investigate with: add repositories, databases or a ticket source (\`ticketsmith project add repos\`).`,
        )
      }

      const budget = flags.budget ?? opened.project.agent.maxBudgetUsd
      io.err(
        `Investigating with Claude (playbook ${flags.playbook}, read-only, budget $${budget.toFixed(2)}, up to ${opened.project.agent.timeoutMinutes} min)…\n`,
      )
      const result = orFail(
        await runInvestigation(
          services,
          opened,
          question,
          { playbook: flags.playbook, model: flags.model, budgetUsd: flags.budget },
          () =>
            startAgentToolServer(command, { auditCommand: 'investigate', only: INVESTIGATE_TOOLS }),
        ),
        String,
      )
      if (global.json) {
        io.out(`${JSON.stringify(result.record, null, 2)}\n`)
        return
      }
      const { investigation, record, dir } = result
      io.out(
        [
          investigation.summary,
          '',
          `Findings: ${severityCounts(investigation.findings) ?? 'none'}`,
          '',
          `Analysis:  ${dir}/analysis.md`,
          `Run:       $${record.costUsd.toFixed(2)} · ${record.turns} turns · ${duration(record.durationMs)}`,
          '',
        ].join('\n'),
      )
    })
