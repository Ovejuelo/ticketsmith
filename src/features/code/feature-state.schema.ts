import { z } from 'zod'
import { FeatureDesignSchema } from '../../core/agent/index.ts'

export const FeatureQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
})
export type FeatureQuestion = z.infer<typeof FeatureQuestionSchema>

export const FeatureStatusSchema = z.enum([
  'questions',
  'plan-ready',
  'rejected',
  'approved',
  'implemented',
])
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>

/**
 * out/<KEY>/feature/state.json (owner-only): where a new-functionality ticket stands. It holds real
 * values, like every file in out/; whatever goes back to the agent is masked again at that moment
 * with the run's own vault, so its placeholders match what the tools resolve.
 */
export const FeatureStateSchema = z.object({
  ticket: z.string(),
  round: z.number().int(),
  status: FeatureStatusSchema,
  /** Every question asked so far, in order. */
  questions: z.array(FeatureQuestionSchema),
  /** Answers from questions.md, by question id. */
  answers: z.record(z.string(), z.string()),
  design: FeatureDesignSchema,
  feedback: z.array(z.string()),
  approval: z.object({ at: z.string(), by: z.string() }).optional(),
  costUsd: z.number(),
})
export type FeatureState = z.infer<typeof FeatureStateSchema>
