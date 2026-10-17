import { z } from 'zod'
import { TicketSchema } from '../../core/tickets/index.ts'

/**
 * evals/<KEY>.yaml, shared with the project: a masked snapshot of a resolved ticket, the type a
 * person says it is, and how it was really solved. No real values, so it can live in git.
 */
export const EvalCaseSchema = z.object({
  ticket: z.string(),
  expectedType: z.string().min(1),
  solution: z.string().optional(),
  addedAt: z.string(),
  snapshot: TicketSchema,
})
export type EvalCase = z.infer<typeof EvalCaseSchema>

export const EvalResultSchema = z.object({
  ticket: z.string(),
  expectedType: z.string(),
  actualType: z.string(),
  confidence: z.number(),
  source: z.enum(['rules', 'llm', 'human']),
  correct: z.boolean(),
  costUsd: z.number(),
  /** --full only: the judge's 1–5 score against the real solution. */
  score: z.number().int().min(1).max(5).optional(),
  judgement: z.string().optional(),
  error: z.string().optional(),
})
export type EvalResult = z.infer<typeof EvalResultSchema>

export const EvalRunSchema = z.object({
  at: z.string(),
  full: z.boolean(),
  results: z.array(EvalResultSchema),
})
export type EvalRun = z.infer<typeof EvalRunSchema>
