import { z } from 'zod'
import {
  type AgentRuntime,
  describeAgentError,
  loadPlaybook,
  runStructured,
} from '../agent/index.ts'
import type { AgentToolServer } from '../cli/index.ts'
import { err, ok, type Result } from '../kernel/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../output/index.ts'
import type { Ticket } from '../tickets/index.ts'
import { classifyByRules, type RuleResult } from './classify-by-rules.ts'
import type { Classification, TicketTypes } from './ticket-types.schema.ts'

export const OTHER = 'other'

export const ClassificationAnswerSchema = z.object({
  type: z.string().min(1).describe('One of the given type names, or "other"'),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).describe('One or two sentences citing the ticket'),
})

/** A type name and how it was decided → the route and playbook it implies. */
export const toClassification = (
  types: TicketTypes,
  type: string,
  confidence: number,
  reason: string,
  source: Classification['source'],
): Classification => {
  const known = types.types.find((candidate) => candidate.name === type)
  return {
    type: known === undefined ? OTHER : type,
    confidence,
    reason,
    source,
    route: known?.route ?? 'unknown',
    playbook: known?.playbook ?? null,
  }
}

export type ClassifyDeps = {
  readonly agent: AgentRuntime
  readonly knowledgeDir: string
  /** Read-only tools for the short LLM run (jira_get_issue, knowledge_*). */
  readonly startToolServer: () => Promise<AgentToolServer>
  readonly model?: string | undefined
  readonly maxBudgetUsd: number
  readonly timeoutMs: number
}

export type ClassifyOutcome = {
  readonly classification: Classification
  readonly rules: RuleResult | null
  readonly costUsd: number
}

/**
 * Rules first (free); when they stay under the threshold and `llm` is on, a short read-only agent
 * run decides with the types' descriptions, the rules' hint and similar resolved cases.
 */
export const classifyTicket = async (
  ticket: Ticket,
  types: TicketTypes,
  deps: ClassifyDeps,
  options: { readonly llm: boolean },
): Promise<Result<ClassifyOutcome, string>> => {
  const rules = classifyByRules(ticket, types)
  if (rules !== null && rules.confidence >= types.threshold) {
    return ok({
      classification: toClassification(types, rules.type, rules.confidence, rules.reason, 'rules'),
      rules,
      costUsd: 0,
    })
  }
  if (!options.llm) {
    return ok({
      classification:
        rules === null
          ? toClassification(types, OTHER, 0, 'No rule matched.', 'rules')
          : toClassification(types, rules.type, rules.confidence, rules.reason, 'rules'),
      rules,
      costUsd: 0,
    })
  }
  const playbook = await loadPlaybook(deps.knowledgeDir, 'classify')
  if (!playbook.ok) return playbook
  const server = await deps.startToolServer()
  const started = Date.now()
  try {
    const result = await runStructured(
      deps.agent,
      {
        prompt: [
          `Classify ticket ${ticket.key}.`,
          'Types:',
          ...types.types.map((type) => `- ${type.name}: ${type.description || '(no description)'}`),
          `- ${OTHER}: none of the above`,
          rules === null
            ? 'The rules matched nothing.'
            : `The rules suggest ${rules.type} (${rules.confidence}): ${rules.reason}. Alternatives: ${rules.alternatives.map((a) => `${a.type} ${a.score}`).join(', ')}.`,
          'Read the ticket with jira_get_issue, look for similar resolved cases with knowledge_search, and answer with the required JSON.',
        ].join('\n'),
        playbook: playbook.value.text,
        mcpConfig: server.mcpConfig,
        model: deps.model,
        maxBudgetUsd: deps.maxBudgetUsd,
        timeoutMs: deps.timeoutMs,
      },
      ClassificationAnswerSchema,
    )
    await server.record({
      tool: 'agent_run',
      input: { ticket: ticket.key, playbook: 'classify' },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs: Date.now() - started,
    })
    if (!result.ok) return err(describeAgentError(result.error))
    const answer = result.value.value
    return ok({
      classification: toClassification(
        types,
        answer.type,
        answer.confidence,
        server.reveal(answer.reason),
        'llm',
      ),
      rules,
      costUsd: result.value.runs.reduce((sum, run) => sum + run.costUsd, 0),
    })
  } finally {
    await server.close()
  }
}

export type ChooseType = (
  message: string,
  choices: readonly { value: string; label: string }[],
  initial: string,
) => Promise<string>

/**
 * Under the threshold a person decides: interactively, from the project's types (the suggestion
 * preselected); without a terminal it stops and says what to run.
 */
export const confirmWithHuman = async (
  key: string,
  outcome: ClassifyOutcome,
  types: TicketTypes,
  io: { readonly interactive: boolean; readonly choose: ChooseType },
): Promise<Result<Classification, string>> => {
  const { classification, rules } = outcome
  if (classification.confidence >= types.threshold && classification.type !== OTHER)
    return ok(classification)
  if (!io.interactive) {
    const alternatives =
      rules?.alternatives
        .slice(0, 2)
        .map((a) => `${a.score} ${a.type}`)
        .join(' vs ') ?? 'no rule matched'
    return err(
      `Ambiguous classification of ${key} (${classification.confidence} ${classification.type}; rules: ${alternatives}). Run \`ticketsmith classify ${key}\` in a terminal, or pass --playbook.`,
    )
  }
  const chosen = await io.choose(
    `${key}: ${classification.type} at ${classification.confidence} (${classification.reason}). Which type is it?`,
    [
      ...types.types.map((type) => ({
        value: type.name,
        label: `${type.name}${type.description ? ` — ${type.description}` : ''}`,
      })),
      { value: OTHER, label: `${OTHER} — none of these` },
    ],
    classification.type,
  )
  return ok(
    toClassification(
      types,
      chosen,
      1,
      `Chosen by a person (suggested ${classification.type} at ${classification.confidence}).`,
      'human',
    ),
  )
}

export const saveClassification = async (
  outDir: string,
  key: string,
  classification: Classification,
): Promise<Result<void, string>> => {
  const written = await writeOutputFiles(ticketOutputDir(outDir, key), {
    'classification.json': `${JSON.stringify({ ticket: key, ...classification, at: new Date().toISOString() }, null, 2)}\n`,
  })
  return written.ok ? ok(undefined) : err(describeOutputError(written.error))
}
