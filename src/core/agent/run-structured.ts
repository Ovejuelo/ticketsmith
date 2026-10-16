import { z } from 'zod'
import { err, ok, type Result } from '../kernel/index.ts'
import type { AgentError, AgentRequest, AgentRun, AgentRuntime } from './agent-runtime.port.ts'

export type StructuredRun<T> = {
  readonly value: T
  /** Every agent session it took (two when the first answer had to be retried). */
  readonly runs: readonly AgentRun[]
}

/**
 * Runs the agent until its answer passes `schema`: the JSON Schema guides the agent, zod has the
 * last word. An invalid answer is retried once with the problems spelled out.
 */
export const runStructured = async <T>(
  runtime: AgentRuntime,
  request: Omit<AgentRequest, 'outputSchema'>,
  schema: z.ZodType<T>,
): Promise<Result<StructuredRun<T>, AgentError>> => {
  // Claude Code's validator rejects the draft 2020-12 meta-schema URI zod adds; the schema itself is plain.
  const { $schema: _metaSchema, ...outputSchema } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >
  const runs: AgentRun[] = []
  let prompt = request.prompt
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = await runtime.run({ ...request, prompt, outputSchema })
    if (!run.ok) return run
    runs.push(run.value)
    const parsed = schema.safeParse(run.value.output)
    if (parsed.success) return ok({ value: parsed.data, runs })
    const issues = z.prettifyError(parsed.error)
    if (attempt === 2) return err({ kind: 'invalid-output', issues })
    prompt = `${request.prompt}\n\nYour previous answer was rejected because it did not match the required schema:\n${issues}\nInvestigate only what is missing and answer again, following the schema exactly.`
  }
  return err({ kind: 'invalid-output', issues: 'no answer' })
}
