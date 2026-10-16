import { z } from 'zod'

export const RepoOutcomeSchema = z.object({
  repo: z.string(),
  dir: z.string(),
  branch: z.string(),
  /** The fix-branch commit the branch started from. */
  base: z.string(),
  target: z.string(),
  commit: z.string().nullable(),
  tests: z
    .object({ exitCode: z.number().nullable(), passed: z.boolean(), timedOut: z.boolean() })
    .nullable(),
  pushed: z.boolean(),
  pullRequest: z.string().nullable(),
})
export type RepoOutcome = z.infer<typeof RepoOutcomeSchema>

/**
 * out/<KEY>/code/run.json: what `code` did and what `code push` needs. The pull request text is
 * kept as the agent wrote it (masked): it leaves this machine, so customer data stays out of it.
 */
export const CodeRunSchema = z.object({
  ticket: z.string(),
  kind: z.enum(['fix', 'feature']).default('fix'),
  playbook: z.string(),
  finishedAt: z.string(),
  costUsd: z.number(),
  turns: z.number(),
  pullRequest: z.object({ title: z.string(), body: z.string() }),
  repos: z.array(RepoOutcomeSchema),
})
export type CodeRun = z.infer<typeof CodeRunSchema>
