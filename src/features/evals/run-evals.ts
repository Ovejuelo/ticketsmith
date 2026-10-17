import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import {
  type AgentRuntime,
  describeAgentError,
  loadPlaybook,
  runStructured,
  TicketAnalysisSchema,
} from '../../core/agent/index.ts'
import { classifyTicket, type TicketTypes } from '../../core/classification/index.ts'
import type { AgentToolServer } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { type MaskingOptions, maskSensitiveData } from '../../core/security/index.ts'
import type { Ticket, TicketSource } from '../../core/tickets/index.ts'
import {
  type EvalCase,
  EvalCaseSchema,
  type EvalResult,
  type EvalRun,
  EvalRunSchema,
} from './eval-case.schema.ts'
import { SnapshotTicketSource } from './snapshot-ticket-source.ts'

const JudgeSchema = z.object({
  score: z.number().int().min(1).max(5),
  reasoning: z.string().min(1),
})

/** Masks the snapshot and the solution together, so their placeholders agree. */
export const buildEvalCase = (
  ticket: Ticket,
  expectedType: string,
  solution: string | undefined,
  masking: MaskingOptions,
): EvalCase => {
  const masked = JSON.parse(
    maskSensitiveData(JSON.stringify({ snapshot: ticket, solution: solution ?? null }), masking)
      .text,
  ) as {
    snapshot: unknown
    solution: string | null
  }
  return EvalCaseSchema.parse({
    ticket: ticket.key,
    expectedType,
    ...(masked.solution === null ? {} : { solution: masked.solution }),
    addedAt: new Date().toISOString().slice(0, 10),
    snapshot: masked.snapshot,
  })
}

export const saveEvalCase = async (
  dir: string,
  evalCase: EvalCase,
): Promise<Result<string, string>> => {
  try {
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${evalCase.ticket}.yaml`)
    await writeFile(file, stringify(evalCase))
    return ok(file)
  } catch (error) {
    return err(`Could not save the eval: ${String(error)}`)
  }
}

export const loadEvalCases = async (dir: string): Promise<Result<readonly EvalCase[], string>> => {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((file) => file.endsWith('.yaml'))
    .sort()
  const cases: EvalCase[] = []
  for (const file of files) {
    try {
      const parsed = EvalCaseSchema.safeParse(parse(await readFile(join(dir, file), 'utf8')))
      if (!parsed.success) return err(`evals/${file} is invalid:\n${z.prettifyError(parsed.error)}`)
      cases.push(parsed.data)
    } catch (error) {
      return err(`evals/${file} is not valid YAML: ${String(error)}`)
    }
  }
  return ok(cases)
}

export type EvalDeps = {
  readonly agent: AgentRuntime
  readonly knowledgeDir: string
  readonly model: string | undefined
  readonly classificationBudgetUsd: number
  readonly runBudgetUsd: number
  readonly timeoutMs: number
  readonly startToolServer: (options: {
    only: (tool: string) => boolean
    tickets: TicketSource
  }) => Promise<AgentToolServer>
}

const CLASSIFY_ONLY = (name: string) =>
  name === 'jira_get_issue' || name === 'knowledge_search' || name === 'knowledge_read'
const READ_ONLY = (name: string) => !name.startsWith('code_') && name !== 'db_propose_change'

/** The analysis of the expected type's playbook, judged against the real solution. */
const judge = async (
  evalCase: EvalCase,
  types: TicketTypes,
  deps: EvalDeps,
  tickets: TicketSource,
): Promise<Result<{ score: number; judgement: string; costUsd: number }, string>> => {
  const type = types.types.find((candidate) => candidate.name === evalCase.expectedType)
  if (type?.playbook === undefined) return err(`no playbook to run for ${evalCase.expectedType}`)
  const playbook = await loadPlaybook(deps.knowledgeDir, type.playbook)
  if (!playbook.ok) return playbook
  const judgePlaybook = await loadPlaybook(deps.knowledgeDir, 'eval-judge')
  if (!judgePlaybook.ok) return judgePlaybook
  let costUsd = 0
  const runner = await deps.startToolServer({ only: READ_ONLY, tickets })
  let answer: unknown
  try {
    const analysis = await runStructured(
      deps.agent,
      {
        prompt: `Investigate ticket ${evalCase.ticket}. Start with knowledge_read("brief.md"), then jira_get_issue. Follow the playbook and finish with the required JSON answer.`,
        playbook: playbook.value.text,
        mcpConfig: runner.mcpConfig,
        model: deps.model,
        maxBudgetUsd: deps.runBudgetUsd,
        timeoutMs: deps.timeoutMs,
      },
      TicketAnalysisSchema,
    )
    if (!analysis.ok) return err(describeAgentError(analysis.error))
    costUsd += analysis.value.runs.reduce((sum, run) => sum + run.costUsd, 0)
    answer = analysis.value.value
  } finally {
    await runner.close()
  }
  const noTools = await deps.startToolServer({ only: () => false, tickets })
  try {
    const verdict = await runStructured(
      deps.agent,
      {
        prompt: [
          `Ticket ${evalCase.ticket}: ${evalCase.snapshot.summary}`,
          '',
          'How it was really solved:',
          evalCase.solution ?? '',
          '',
          "The agent's analysis (JSON):",
          JSON.stringify(answer),
          '',
          'Score it with the required JSON.',
        ].join('\n'),
        playbook: judgePlaybook.value.text,
        mcpConfig: noTools.mcpConfig,
        model: deps.model,
        maxBudgetUsd: deps.classificationBudgetUsd,
        timeoutMs: deps.timeoutMs,
      },
      JudgeSchema,
    )
    if (!verdict.ok) return err(describeAgentError(verdict.error))
    costUsd += verdict.value.runs.reduce((sum, run) => sum + run.costUsd, 0)
    return ok({
      score: verdict.value.value.score,
      judgement: verdict.value.value.reasoning,
      costUsd,
    })
  } finally {
    await noTools.close()
  }
}

/**
 * Classifies every case from its snapshot (rules, then the LLM; never a person), and with `full`
 * runs the expected type's playbook and has an LLM judge it against the real solution, until the
 * total budget is spent.
 */
export const runEvals = async (
  cases: readonly EvalCase[],
  types: TicketTypes,
  deps: EvalDeps,
  options: { readonly full: boolean; readonly llm: boolean; readonly budgetUsd: number },
): Promise<EvalRun> => {
  const results: EvalResult[] = []
  let spent = 0
  for (const evalCase of cases) {
    const tickets = new SnapshotTicketSource(evalCase.snapshot)
    const outcome = await classifyTicket(
      evalCase.snapshot,
      types,
      {
        agent: deps.agent,
        knowledgeDir: deps.knowledgeDir,
        startToolServer: () => deps.startToolServer({ only: CLASSIFY_ONLY, tickets }),
        model: deps.model,
        maxBudgetUsd: deps.classificationBudgetUsd,
        timeoutMs: deps.timeoutMs,
      },
      { llm: options.llm },
    )
    if (!outcome.ok) {
      results.push({
        ticket: evalCase.ticket,
        expectedType: evalCase.expectedType,
        actualType: 'error',
        confidence: 0,
        source: 'rules',
        correct: false,
        costUsd: 0,
        error: outcome.error,
      })
      continue
    }
    const { classification } = outcome.value
    spent += outcome.value.costUsd
    let result: EvalResult = {
      ticket: evalCase.ticket,
      expectedType: evalCase.expectedType,
      actualType: classification.type,
      confidence: classification.confidence,
      source: classification.source,
      correct: classification.type === evalCase.expectedType,
      costUsd: outcome.value.costUsd,
    }
    if (options.full && evalCase.solution !== undefined) {
      if (spent >= options.budgetUsd) {
        result = { ...result, error: 'skipped: the eval budget is spent' }
      } else {
        const judged = await judge(evalCase, types, deps, tickets)
        result = judged.ok
          ? {
              ...result,
              score: judged.value.score,
              judgement: judged.value.judgement,
              costUsd: result.costUsd + judged.value.costUsd,
            }
          : { ...result, error: judged.error }
        if (judged.ok) spent += judged.value.costUsd
      }
    }
    results.push(result)
  }
  return { at: new Date().toISOString(), full: options.full, results }
}

export const saveRun = async (dir: string, run: EvalRun): Promise<Result<string, string>> => {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${run.at.replace(/[:.]/g, '-')}.json`)
    await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
    return ok(file)
  } catch (error) {
    return err(`Could not save the eval run: ${String(error)}`)
  }
}

export const latestRun = async (dir: string): Promise<EvalRun | null> => {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((file) => file.endsWith('.json'))
    .sort()
  const last = files.at(-1)
  if (last === undefined) return null
  const parsed = EvalRunSchema.safeParse(JSON.parse(await readFile(join(dir, last), 'utf8')))
  return parsed.success ? parsed.data : null
}

/** Cases that got worse since the previous run: no longer classified right, or judged 2+ points lower. */
export const findRegressions = (previous: EvalRun | null, current: EvalRun): readonly string[] => {
  if (previous === null) return []
  const before = new Map(previous.results.map((result) => [result.ticket, result]))
  return current.results.flatMap((result) => {
    const old = before.get(result.ticket)
    if (old === undefined) return []
    const problems: string[] = []
    if (old.correct && !result.correct)
      problems.push(
        `${result.ticket}: now ${result.actualType}, was ${old.actualType} (expected ${result.expectedType})`,
      )
    if (old.score !== undefined && result.score !== undefined && old.score - result.score >= 2) {
      problems.push(`${result.ticket}: judged ${result.score}/5, was ${old.score}/5`)
    }
    return problems
  })
}

const percent = (part: number, whole: number) =>
  whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`

export const renderReport = (run: EvalRun, regressions: readonly string[]): string => {
  const { results } = run
  const correct = results.filter((r) => r.correct).length
  const byType = new Map<string, EvalResult[]>()
  for (const result of results)
    byType.set(result.expectedType, [...(byType.get(result.expectedType) ?? []), result])
  const confusion = new Map<string, number>()
  for (const result of results.filter((r) => !r.correct)) {
    const key = `${result.expectedType} → ${result.actualType}`
    confusion.set(key, (confusion.get(key) ?? 0) + 1)
  }
  const scored = results.filter((r) => r.score !== undefined)
  const cost = results.reduce((sum, r) => sum + r.costUsd, 0)
  return [
    `Classification: ${correct}/${results.length} right (${percent(correct, results.length)}); ${results.filter((r) => r.source === 'rules' && r.correct).length} decided by the rules alone.`,
    ...[...byType].map(
      ([type, list]) =>
        `  ${type.padEnd(20)} ${list.filter((r) => r.correct).length}/${list.length}`,
    ),
    ...(confusion.size === 0
      ? []
      : ['Mistakes:', ...[...confusion].map(([pair, count]) => `  ${pair}: ${count}`)]),
    ...(scored.length === 0
      ? []
      : [
          `Judged answers: average ${(scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length).toFixed(1)}/5 over ${scored.length}`,
        ]),
    ...results.filter((r) => r.error !== undefined).map((r) => `  ${r.ticket}: ${r.error}`),
    `Cost: $${cost.toFixed(2)}`,
    ...(regressions.length === 0
      ? ['No regressions against the previous run.']
      : ['REGRESSIONS:', ...regressions.map((r) => `  ${r}`)]),
    '',
  ].join('\n')
}
