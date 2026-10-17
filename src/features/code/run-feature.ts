import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeAgentError,
  type FeatureDesign,
  FeatureDesignSchema,
  type FeatureImplementation,
  FeatureImplementationSchema,
  loadPlaybook,
  runStructured,
} from '../../core/agent/index.ts'
import type { AgentToolServer, ConnectedTickets, OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import type { CodeToolContext } from '../../core/mcp/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../../core/output/index.ts'
import { revealDeep } from '../../core/security/index.ts'
import type { Services } from '../../core/services/index.ts'
import { describeTicketSourceError, type TicketKey } from '../../core/tickets/index.ts'
import {
  newMigrations,
  parseAnswers,
  renderPlan,
  renderQuestions,
  renderSpec,
} from './feature-files.ts'
import {
  type FeatureQuestion,
  type FeatureState,
  FeatureStateSchema,
} from './feature-state.schema.ts'
import {
  type CodeOptions,
  type CodeOutcome,
  runWorktreeChange,
  type WorktreeChangeSpec,
} from './run-code-change.ts'

export const featureDir = (outDir: string, key: string): string =>
  join(ticketOutputDir(outDir, key), 'feature')

export const loadFeatureState = async (
  outDir: string,
  key: string,
): Promise<Result<FeatureState | null, string>> => {
  let text: string
  try {
    text = await readFile(join(featureDir(outDir, key), 'state.json'), 'utf8')
  } catch {
    return ok(null)
  }
  const parsed = FeatureStateSchema.safeParse(JSON.parse(text))
  return parsed.success ? ok(parsed.data) : err(`out/${key}/feature/state.json is unreadable.`)
}

export const saveFeatureState = async (
  outDir: string,
  state: FeatureState,
  files: Readonly<Record<string, string>> = {},
) => {
  const written = await writeOutputFiles(featureDir(outDir, state.ticket), {
    ...files,
    'state.json': `${JSON.stringify(state, null, 2)}\n`,
  })
  return written.ok ? ok(undefined) : err(describeOutputError(written.error))
}

export type DesignStep =
  | {
      readonly kind: 'designed'
      readonly state: FeatureState
      readonly newQuestions: readonly FeatureQuestion[]
    }
  | {
      readonly kind: 'waiting-for-answers'
      readonly state: FeatureState
      readonly open: readonly FeatureQuestion[]
    }
  | {
      readonly kind: 'waiting-for-approval' | 'approved' | 'implemented'
      readonly state: FeatureState
    }

/** What the agent is reminded of in a later round: answers, feedback and its previous design. */
const history = (state: FeatureState | null): string[] => {
  if (state === null) return []
  const answered = state.questions.filter((q) => state.answers[q.id] !== undefined)
  return [
    '',
    `Previous design (round ${state.round}), to revise rather than start over:`,
    JSON.stringify(state.design),
    ...(answered.length === 0
      ? []
      : [
          '',
          'Answers to your questions:',
          ...answered.map((q) => `- ${q.id}. ${q.question}\n  Answer: ${state.answers[q.id]}`),
        ]),
    ...(state.feedback.length === 0
      ? []
      : [
          '',
          'Feedback on rejected plans (address every point):',
          ...state.feedback.map((f) => `- ${f}`),
        ]),
  ]
}

/**
 * The next design step of a new-functionality ticket: waits while questions.md has open
 * questions, otherwise runs the design (read-only tools only) and writes spec.md, plan.md and,
 * when new questions come up, questions.md. Nothing happens to code at this stage.
 */
export const designFeature = async (
  services: Services,
  opened: OpenedProject,
  tickets: ConnectedTickets,
  key: TicketKey,
  options: { readonly model?: string | undefined; readonly budgetUsd?: number | undefined },
  startToolServer: () => Promise<AgentToolServer>,
): Promise<Result<DesignStep, string>> => {
  const { project, paths } = opened
  const loaded = await loadFeatureState(paths.outDir, key)
  if (!loaded.ok) return loaded
  let state = loaded.value
  if (state !== null && state.status === 'plan-ready')
    return ok({ kind: 'waiting-for-approval', state })
  if (state !== null && state.status === 'approved') return ok({ kind: 'approved', state })
  if (state !== null && state.status === 'implemented') return ok({ kind: 'implemented', state })
  if (state !== null && state.status === 'questions') {
    const pending = state.questions.filter((q) => state?.answers[q.id] === undefined)
    let text = ''
    try {
      text = await readFile(join(featureDir(paths.outDir, key), 'questions.md'), 'utf8')
    } catch {
      return err(`out/${key}/feature/questions.md is missing; answer the questions there.`)
    }
    const parsed = parseAnswers(text, pending)
    if (!parsed.ok) return parsed
    state = { ...state, answers: { ...state.answers, ...parsed.value.answers } }
    if (parsed.value.open.length > 0) {
      await saveFeatureState(paths.outDir, state)
      return ok({ kind: 'waiting-for-answers', state, open: parsed.value.open })
    }
  }

  const ticket = await tickets.source.getTicket(key)
  if (!ticket.ok) return err(describeTicketSourceError(ticket.error))
  const playbook = await loadPlaybook(paths.knowledgeDir, 'feature-design')
  if (!playbook.ok) return playbook

  const server = await startToolServer()
  let design: FeatureDesign
  let costUsd = 0
  try {
    const started = Date.now()
    const result = await runStructured(
      services.agentFor(project),
      {
        prompt: server.mask(
          [
            `Design new functionality for ticket ${key} of the project "${project.name}".`,
            'Read knowledge_read("brief.md") and the ticket (jira_get_issue) first. Follow the playbook in your instructions and finish with the required JSON answer.',
            ...history(state),
          ].join('\n'),
        ),
        playbook: playbook.value.text,
        mcpConfig: server.mcpConfig,
        model: options.model ?? project.agent.model,
        maxBudgetUsd: options.budgetUsd ?? project.agent.maxBudgetUsd,
        timeoutMs: project.agent.timeoutMinutes * 60_000,
      },
      FeatureDesignSchema,
    )
    await server.record({
      tool: 'agent_run',
      input: { ticket: key, playbook: 'feature-design', round: (state?.round ?? 0) + 1 },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs: Date.now() - started,
    })
    if (!result.ok) return err(describeAgentError(result.error))
    design = revealDeep(result.value.value, server.reveal)
    costUsd = result.value.runs.reduce((sum, run) => sum + run.costUsd, 0)
  } finally {
    await server.close()
  }

  const asked = state?.questions ?? []
  const newQuestions: FeatureQuestion[] = design.questions.map((q, i) => ({
    id: `Q${asked.length + i + 1}`,
    question: q.question,
    why: q.why,
  }))
  const round = (state?.round ?? 0) + 1
  const tentative = newQuestions.length > 0
  const next: FeatureState = {
    ticket: key,
    round,
    status: tentative ? 'questions' : 'plan-ready',
    questions: [...asked, ...newQuestions],
    answers: state?.answers ?? {},
    design,
    feedback: state?.feedback ?? [],
    costUsd: (state?.costUsd ?? 0) + costUsd,
  }
  const saved = await saveFeatureState(paths.outDir, next, {
    'spec.md': renderSpec(key, design, tentative),
    'plan.md': renderPlan(key, design, tentative),
    ...(tentative ? { 'questions.md': renderQuestions(key, round, newQuestions) } : {}),
  })
  if (!saved.ok) return saved
  return ok({ kind: 'designed', state: next, newQuestions })
}

const criteriaSection = (
  change: FeatureImplementation,
  patches: Readonly<Record<string, string>>,
): string[] => {
  const detected = Object.entries(patches).flatMap(([repo, patch]) =>
    newMigrations(patch).map((file) => `${repo}/${file}`),
  )
  return [
    '## Acceptance criteria',
    '',
    '| Criterion | Met | Evidence |',
    '| --- | --- | --- |',
    ...change.acceptanceCriteria.map(
      (c) =>
        `| ${c.criterion.replaceAll('|', '\\|')} | ${c.met ? 'yes' : '**no**'} | ${c.evidence.replaceAll('|', '\\|')} |`,
    ),
    '',
    '## Schema migrations (files in the repository; they were not run)',
    '',
    ...(detected.length > 0 ? detected.map((file) => `- ${file}`) : ['- None added.']),
    '',
  ]
}

/** `ticketsmith feature implement`: builds the approved plan from each repository's feature branch. */
export const implementFeature = async (
  services: Services,
  opened: OpenedProject,
  tickets: ConnectedTickets,
  key: TicketKey,
  options: Omit<CodeOptions, 'playbook'>,
  startToolServer: (code: CodeToolContext) => Promise<AgentToolServer>,
): Promise<Result<CodeOutcome<FeatureImplementation>, string>> => {
  const loaded = await loadFeatureState(opened.paths.outDir, key)
  if (!loaded.ok) return loaded
  const state = loaded.value
  if (state === null) return err(`No design for ${key} yet: run \`ticketsmith feature ${key}\`.`)
  if (state.status !== 'approved' && state.status !== 'implemented') {
    return err(
      `The plan of ${key} is not approved (${state.status}): approve it with \`ticketsmith feature approve ${key}\` first.`,
    )
  }
  const spec: WorktreeChangeSpec<FeatureImplementation> = {
    kind: 'feature',
    schema: FeatureImplementationSchema,
    title: 'new functionality',
    prompt: (ticketKey, worktrees, mask) =>
      [
        `Implement the approved new functionality of ticket ${ticketKey}.`,
        `Your worktrees (one feature branch per repository): ${worktrees.map((w) => `${w.repository.config.name} (branch ${w.branch}) at ${w.dir}`).join('; ')}.`,
        'Approved spec and plan (JSON):',
        mask(
          JSON.stringify({
            spec: state.design.spec,
            plan: state.design.plan,
            assumptions: state.design.assumptions,
          }),
        ),
        'Follow the playbook in your instructions and finish with the required JSON answer.',
      ].join('\n'),
    summarize: criteriaSection,
  }
  const outcome = await runWorktreeChange(
    services,
    opened,
    tickets,
    key,
    { ...options, playbook: 'feature-implement' },
    spec,
    startToolServer,
  )
  if (!outcome.ok) return outcome
  const saved = await saveFeatureState(opened.paths.outDir, {
    ...state,
    status: 'implemented',
    costUsd: state.costUsd + outcome.value.run.costUsd,
  })
  return saved.ok ? outcome : saved
}
