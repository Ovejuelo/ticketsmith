import { readdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import {
  askConfirm,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { reviewRun } from '../../core/knowledge/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'
import { terminalPushIo } from './code.command.ts'
import { pushAndOpen } from './push.ts'
import { codeOutputDir } from './run-code-change.ts'
import {
  designFeature,
  featureDir,
  implementFeature,
  loadFeatureState,
  saveFeatureState,
} from './run-feature.ts'

const parseKey = (raw: string) => {
  const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
  if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
  return parsed.data
}

const parseBudget = (value: string): number => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100) fail(`Invalid --budget "${value}".`)
  return amount
}

/** Design tools only read: no code tools and no change proposals while designing. */
const DESIGN_TOOLS = (name: string): boolean =>
  !name.startsWith('code_') && name !== 'db_propose_change'

export const featureCommand = (deps: CommandDeps): Command => {
  const { io, servicesFor, startAgentToolServer } = deps
  const opened = (command: Command) =>
    openProject(servicesFor(command), globalOptions(command).project)

  return new Command('feature')
    .description(
      'New functionality with a design checkpoint: questions, spec and plan you approve, then code',
    )
    .argument('[key]', 'ticket key, e.g. OPS-123')
    .option('--model <model>', 'Claude model (default: agent.model or your Claude Code default)')
    .option('--budget <usd>', 'maximum spend for this run, in US dollars', parseBudget)
    .action(
      async (
        raw: string | undefined,
        flags: { model?: string; budget?: number },
        command: Command,
      ) => {
        if (raw === undefined) {
          command.help()
          return
        }
        const key = parseKey(raw)
        const services = servicesFor(command)
        const project = await opened(command)
        const tickets = await requireTickets(services, project)
        const dir = featureDir(project.paths.outDir, key)
        const before = orFail(await loadFeatureState(project.paths.outDir, key), String)
        if (before === null || before.status === 'questions' || before.status === 'rejected') {
          io.err(`Designing ${key} with Claude (read-only: no code is written in this step)…\n`)
        }
        const step = orFail(
          await designFeature(
            services,
            project,
            tickets,
            key,
            { model: flags.model, budgetUsd: flags.budget },
            () => startAgentToolServer(command, { auditCommand: 'feature', only: DESIGN_TOOLS }),
          ),
          String,
        )
        switch (step.kind) {
          case 'waiting-for-answers':
            io.out(
              [
                `${key} is waiting for answers to ${step.open.map((q) => q.id).join(', ')}.`,
                `Write them under "Answer:" in ${join(dir, 'questions.md')}, then run \`ticketsmith feature ${key}\` again.`,
                '',
              ].join('\n'),
            )
            return
          case 'designed':
            io.out(
              [
                `${key}: ${step.state.design.spec.summary}`,
                '',
                `Spec: ${join(dir, 'spec.md')}`,
                `Plan: ${join(dir, 'plan.md')}`,
                '',
                ...(step.newQuestions.length > 0
                  ? [
                      `The design needs ${step.newQuestions.length} answer(s) first (spec and plan are tentative):`,
                      ...step.newQuestions.map((q) => `  ${q.id}. ${q.question}`),
                      '',
                      `Answer them in ${join(dir, 'questions.md')}, then run \`ticketsmith feature ${key}\` again.`,
                    ]
                  : [
                      'Review the spec and the plan, then:',
                      `  ticketsmith feature approve ${key}`,
                      `  ticketsmith feature reject ${key} --feedback "…"`,
                    ]),
                '',
              ].join('\n'),
            )
            return
          case 'waiting-for-approval':
            io.out(
              `The plan of ${key} is waiting for you: review ${join(dir, 'plan.md')}, then \`ticketsmith feature approve ${key}\` or \`reject\`.\n`,
            )
            return
          case 'approved':
            io.out(
              `The plan of ${key} is approved: build it with \`ticketsmith feature implement ${key}\`.\n`,
            )
            return
          case 'implemented':
            io.out(
              `${key} is implemented: review ${codeOutputDir(project.paths.outDir, key, 'feature')}, then \`ticketsmith feature push ${key}\`.\n`,
            )
        }
      },
    )
    .addCommand(
      new Command('approve')
        .description('Approve the plan (interactive): only then can code be written')
        .argument('<key>', 'ticket key')
        .action(async (raw: string, _, command: Command) => {
          if (!io.interactive)
            fail('Approving a plan needs an interactive terminal: run it yourself.')
          const key = parseKey(raw)
          const project = await opened(command)
          const state = orFail(await loadFeatureState(project.paths.outDir, key), String)
          if (state === null || state.status !== 'plan-ready') {
            fail(
              `There is no plan of ${key} waiting for approval${state === null ? '' : ` (${state.status})`}.`,
            )
          }
          const { plan, spec } = state.design
          io.out(
            [
              `${key}: ${spec.summary}`,
              '',
              `${spec.acceptanceCriteria.length} acceptance criteria · ${plan.repos.map((r) => `${r.repo} (${r.changes.length} changes)`).join(', ')}`,
              `${plan.schemaChanges.length} schema change(s) as migration files`,
              `Full plan: ${join(featureDir(project.paths.outDir, key), 'plan.md')}`,
              '',
            ].join('\n'),
          )
          if (!(await askConfirm(`Approve this plan for ${key}?`, false))) fail('Not approved.')
          orFail(
            await saveFeatureState(project.paths.outDir, {
              ...state,
              status: 'approved',
              approval: { at: new Date().toISOString(), by: userInfo().username },
            }),
            String,
          )
          io.out(`Approved. Build it with \`ticketsmith feature implement ${key}\`.\n`)
        }),
    )
    .addCommand(
      new Command('reject')
        .description('Reject the plan with feedback; the next `feature <KEY>` redesigns with it')
        .argument('<key>', 'ticket key')
        .requiredOption('--feedback <text>', 'what to change')
        .action(async (raw: string, options: { feedback: string }, command: Command) => {
          const key = parseKey(raw)
          const project = await opened(command)
          const state = orFail(await loadFeatureState(project.paths.outDir, key), String)
          if (state === null || (state.status !== 'plan-ready' && state.status !== 'approved')) {
            fail(`There is no plan of ${key} to reject.`)
          }
          const { approval: _approval, ...rest } = state
          orFail(
            await saveFeatureState(project.paths.outDir, {
              ...rest,
              status: 'rejected',
              feedback: [...state.feedback, options.feedback.trim()],
            }),
            String,
          )
          io.out(`Rejected. Run \`ticketsmith feature ${key}\` to redesign with your feedback.\n`)
        }),
    )
    .addCommand(
      new Command('implement')
        .description(
          'Build the approved plan in a worktree per repository, from the feature branch',
        )
        .argument('<key>', 'ticket key')
        .option(
          '--repo <names...>',
          'only these repositories (default: every one with allowCodeChanges)',
        )
        .option('--model <model>', 'Claude model')
        .option('--budget <usd>', 'maximum spend for this run, in US dollars', parseBudget)
        .action(
          async (
            raw: string,
            flags: { repo?: string[]; model?: string; budget?: number },
            command: Command,
          ) => {
            const key = parseKey(raw)
            const services = servicesFor(command)
            const project = await opened(command)
            const tickets = await requireTickets(services, project)
            io.err(`Building the approved plan of ${key} with Claude…\n`)
            const outcome = orFail(
              await implementFeature(
                services,
                project,
                tickets,
                key,
                { repos: flags.repo, model: flags.model, budgetUsd: flags.budget },
                (code) => startAgentToolServer(command, { auditCommand: 'feature', code }),
              ),
              String,
            )
            const { change, run, stats, dir } = outcome
            const unmet = change.acceptanceCriteria.filter((c) => !c.met)
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
                `Acceptance criteria: ${change.acceptanceCriteria.length - unmet.length} of ${change.acceptanceCriteria.length} met${unmet.length > 0 ? ` (not met: ${unmet.map((c) => c.criterion).join('; ')})` : ''}`,
                `Summary and diffs: ${dir}`,
                `Run: $${run.costUsd.toFixed(2)} · ${run.turns} turns`,
                '',
              ].join('\n'),
            )
            if (!run.repos.some((repo) => repo.commit !== null)) return
            if (!io.interactive) {
              io.out(
                `Review the diffs, then push and open the pull requests with: ticketsmith feature push ${key}\n`,
              )
              return
            }
            orFail(
              await pushAndOpen(services, project, dir, key, undefined, terminalPushIo(io)),
              String,
            )
            await reviewRun(project, key, (text) => io.out(text))
          },
        ),
    )
    .addCommand(
      new Command('push')
        .description(
          'Push the feature branches and open linked pull requests (asks per repository)',
        )
        .argument('<key>', 'ticket key')
        .option('--repo <names...>', 'only these repositories')
        .action(async (raw: string, options: { repo?: string[] }, command: Command) => {
          if (!io.interactive) fail('Pushing needs an interactive terminal: run it yourself.')
          const key = parseKey(raw)
          const services = servicesFor(command)
          const project = await opened(command)
          orFail(
            await pushAndOpen(
              services,
              project,
              codeOutputDir(project.paths.outDir, key, 'feature'),
              key,
              options.repo,
              terminalPushIo(io),
            ),
            String,
          )
        }),
    )
    .addCommand(
      new Command('status')
        .description('New-functionality tickets and where each one stands')
        .action(async (_, command: Command) => {
          const { paths } = await opened(command)
          const keys = await readdir(paths.outDir).catch(() => [] as string[])
          let any = false
          for (const key of keys.sort()) {
            const state = await loadFeatureState(paths.outDir, key)
            if (!state.ok || state.value === null) continue
            any = true
            const open = state.value.questions.filter(
              (q) => state.value?.answers[q.id] === undefined,
            ).length
            io.out(
              `${key}  ${state.value.status.padEnd(12)} round ${state.value.round}${open > 0 ? ` · ${open} open question(s)` : ''} · $${state.value.costUsd.toFixed(2)}  ${state.value.design.spec.summary.slice(0, 70)}\n`,
            )
          }
          if (!any) io.out('No new-functionality tickets in this project yet.\n')
        }),
    )
}
