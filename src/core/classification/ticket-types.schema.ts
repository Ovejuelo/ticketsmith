import { z } from 'zod'

const words = z.array(z.string().min(1)).default([])

export const TicketTypeSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and "-"'),
    description: z.string().default(''),
    /** Which command handles it: process (a playbook), code (a fix) or feature (new functionality). */
    route: z.enum(['process', 'code', 'feature']).default('process'),
    playbook: z.string().optional(),
    match: z
      .object({ issueTypes: words, labels: words, components: words, keywords: words })
      .default({ issueTypes: [], labels: [], components: [], keywords: [] }),
  })
  .refine((type) => type.route !== 'process' || type.playbook !== undefined, {
    message: 'Types routed to `process` need a playbook',
    path: ['playbook'],
  })
export type TicketType = z.infer<typeof TicketTypeSchema>

/** knowledge/ticket-types.md front matter: the project's ticket types and the signals that find them. */
export const TicketTypesSchema = z
  .object({
    threshold: z.number().min(0).max(1).default(0.75),
    types: z.array(TicketTypeSchema).min(1),
  })
  .superRefine((config, context) => {
    const seen = new Set<string>()
    config.types.forEach((type, index) => {
      if (seen.has(type.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate type "${type.name}"`,
          path: ['types', index, 'name'],
        })
      }
      seen.add(type.name)
    })
  })
export type TicketTypes = z.infer<typeof TicketTypesSchema>

export type Classification = {
  readonly type: string
  readonly confidence: number
  readonly reason: string
  /** Who decided: the rules, the LLM, or a person when both were unsure. */
  readonly source: 'rules' | 'llm' | 'human'
  readonly route: TicketType['route'] | 'unknown'
  readonly playbook: string | null
}
