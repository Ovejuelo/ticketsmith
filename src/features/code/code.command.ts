import { readdir } from 'node:fs/promises'
import { Command } from 'commander'
import {
  askConfirm,
  askSecret,
  type CommandDeps,
  fail,
  globalOptions,
  type Io,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { removeWorktree, worktreeDir } from '../../core/repos/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'
import { type PushIo, pushAndOpen } from './push.ts'
import { codeOutputDir, loadCodeRun, runCodeChange, saveCodeRun } from './run-code-change.ts'

type CodeFlags = {
  readonly repo?: string[]
  readonly playbook: string
  readonly model?: string
  readonly budget?: number
}

const parseBudget = (value: string): number => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100) fail(`Invalid --budget "${value}".`)
  return amount
}

const parseKey = (raw: string) => {
  const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
  if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
  return parsed.data
}

const terminalPushIo = (io: Io): PushIo => ({
  show: (text) => io.out(`${text}\n`),
  confirm: (question) => askConfirm(question, false),
  askToken: async (hostname) => {
    const wants = await askConfirm(
      `No pull request token for ${hostname}. Add one now (stored in the system keychain)?`,
      true,
    )
    if (!wants) return null
    const token = (await askSecret(`API token for ${hostname} (pull request write access)`)).trim()
    return token === '' ? null : token
  },
})

const pushCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('push')
    .description("Push a ticket's branches and open the pull requests (asks per repository)")
    .argument('<key>', 'ticket key')
    .option('--repo <names...>', 'only these repositories')
    .action(async (raw: string, options: { repo?: string[] }, command: Command) => {
      if (!io.interactive) fail('Pushing needs an interactive terminal: run it yourself.')
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      const key = parseKey(raw)
      orFail(
        await pushAndOpen(
          services,
          opened,
          codeOutputDir(opened.paths.outDir, key),
          key,
          options.repo,
          terminalPushIo(io),
        ),
        String,
      )
    })

const statusCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('status')
    .description('Ticket worktrees, their branches, pushes and pull requests')
    .action(async (_, command: Command) => {
      const { paths } = await openProject(servicesFor(command), globalOptions(command).project)
      const keys = await readdir(paths.outDir).catch(() => [] as string[])
      let any = false
      for (const key of keys.sort()) {
        const run = await loadCodeRun(codeOutputDir(paths.outDir, key), key)
        if (!run.ok) continue
        any = true
        for (const repo of run.value.repos) {
          const state =
            repo.pullRequest ??
            (repo.pushed ? 'pushed' : repo.commit === null ? 'no changes' : 'not pushed')
          const tests =
            repo.tests === null ? 'no tests' : repo.tests.passed ? 'tests pass' : 'tests FAIL'
          io.out(
            `${key}  ${repo.repo.padEnd(16)} ${repo.branch} → ${repo.target}  ${tests}  ${state}\n`,
          )
        }
      }
      if (!any) io.out('No code changes in this project yet.\n')
    })

const discardCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('discard')
    .description(
      "Remove a ticket's worktrees and local branches (pushed branches stay on the remote)",
    )
    .argument('<key>', 'ticket key')
    .option('--yes', 'do not ask for confirmation', false)
    .action(async (raw: string, options: { yes: boolean }, command: Command) => {
      const key = parseKey(raw)
      const { project, paths } = await openProject(
        servicesFor(command),
        globalOptions(command).project,
      )
      const run = orFail(await loadCodeRun(codeOutputDir(paths.outDir, key), key), String)
      if (!options.yes) {
        if (!io.interactive) fail('Pass --yes to discard without a terminal.')
        if (!(await askConfirm(`Remove the worktrees and local branches of ${key}?`, false)))
          fail('Nothing removed.')
      }
      for (const repo of run.repos) {
        const clone = project.integrations.repos?.find((r) => r.name === repo.repo)
        if (clone === undefined) continue
        orFail(
          await removeWorktree(
            `${paths.reposDir}/${clone.name}`,
            worktreeDir(paths, key, repo.repo),
            repo.branch,
          ),
          String,
        )
      }
      orFail(await saveCodeRun(codeOutputDir(paths.outDir, key), { ...run, repos: [] }), String)
      io.out(
        `Discarded the worktrees of ${key}. The diffs and summary stay in ${codeOutputDir(paths.outDir, key)}.\n`,
      )
    })

export { terminalPushIo }

export const codeCommand = (deps: CommandDeps): Command => {
  const { io, servicesFor, startAgentToolServer } = deps
  return new Command('code')
    .description(
      'Fix a ticket in code: a worktree per repository, tests, then push and PR when you agree',
    )
    .argument('[key]', 'ticket key, e.g. OPS-123')
    .option(
      '--repo <names...>',
      'only these repositories (default: every one with allowCodeChanges)',
    )
    .option('--playbook <name>', 'playbook: knowledge/playbooks/<name>.md or built-in', 'code-fix')
    .option('--model <model>', 'Claude model (default: agent.model or your Claude Code default)')
    .option('--budget <usd>', 'maximum spend for this run, in US dollars', parseBudget)
    .action(async (raw: string | undefined, flags: CodeFlags, command: Command) => {
      if (raw === undefined) {
        command.help()
        return
      }
      const key = parseKey(raw)
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      const tickets = await requireTickets(services, opened)
      io.err(
        `Fixing ${key} with Claude (playbook ${flags.playbook}, budget $${(flags.budget ?? opened.project.agent.maxBudgetUsd).toFixed(2)}, up to ${opened.project.agent.timeoutMinutes} min)…\n`,
      )
      const outcome = orFail(
        await runCodeChange(
          services,
          opened,
          tickets,
          key,
          {
            playbook: flags.playbook,
            repos: flags.repo,
            model: flags.model,
            budgetUsd: flags.budget,
          },
          (code) => startAgentToolServer(command, { auditCommand: 'code', code }),
        ),
        String,
      )
      const { change, run, stats, dir } = outcome
      io.out(
        [
          `${key}: ${change.summary}`,
          '',
          ...run.repos.flatMap((repo) => [
            `${repo.repo}: ${repo.branch} → ${repo.target}${repo.commit === null ? ' (no changes)' : ''}`,
            ...(stats[repo.repo] ?? '')
              .trimEnd()
              .split('\n')
              .filter((line) => line !== '')
              .map((line) => `  ${line}`),
            `  Tests (run again by Ticketsmith): ${repo.tests === null ? 'no test command configured' : repo.tests.passed ? 'passed' : 'FAILED'}`,
          ]),
          '',
          `Summary and diffs: ${dir}`,
          `Run: $${run.costUsd.toFixed(2)} · ${run.turns} turns`,
          '',
        ].join('\n'),
      )
      if (!run.repos.some((repo) => repo.commit !== null)) return
      if (!io.interactive) {
        io.out(
          `Review the diffs, then push and open the pull requests with: ticketsmith code push ${key}\n`,
        )
        return
      }
      orFail(
        await pushAndOpen(
          services,
          opened,
          codeOutputDir(opened.paths.outDir, key),
          key,
          undefined,
          terminalPushIo(io),
        ),
        String,
      )
    })
    .addCommand(pushCommand(deps))
    .addCommand(statusCommand(deps))
    .addCommand(discardCommand(deps))
}
