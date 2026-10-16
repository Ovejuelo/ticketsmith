import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runStructured } from '#src/core/agent/run-structured.ts'
import { FakeAgentRuntime } from '#tests/support/fake-agent-runtime.ts'

const Answer = z.object({ answer: z.string().min(3) })
const request = {
  prompt: 'Investigate.',
  playbook: '# Playbook',
  mcpConfig: { mcpServers: {} },
  maxBudgetUsd: 1,
  timeoutMs: 1000,
}

describe('runStructured', () => {
  it('passes the JSON Schema of the zod schema and returns the validated answer', async () => {
    const agent = new FakeAgentRuntime().reply({ answer: 'found' })
    const result = await runStructured(agent, request, Answer)
    expect(result.ok && result.value.value).toEqual({ answer: 'found' })
    expect(agent.requests[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string', minLength: 3 } },
    })
  })

  it('retries once with the problems when the answer is invalid', async () => {
    const agent = new FakeAgentRuntime().reply({ answer: 'no' }, { answer: 'fixed' })
    const result = await runStructured(agent, request, Answer)
    expect(result.ok && result.value.value).toEqual({ answer: 'fixed' })
    expect(result.ok && result.value.runs).toHaveLength(2)
    expect(agent.requests[1]?.prompt).toMatch(/^Investigate\.\n\nYour previous answer was rejected/)
    expect(agent.requests[1]?.prompt).toContain('answer')
  })

  it('gives up after the retry and surfaces agent errors as they are', async () => {
    const invalid = await runStructured(
      new FakeAgentRuntime().reply({ answer: 1 }),
      request,
      Answer,
    )
    expect(invalid.ok === false && invalid.error.kind).toBe('invalid-output')

    const budget = await runStructured(
      new FakeAgentRuntime().reply({ kind: 'budget-exceeded', costUsd: 1.2 }),
      request,
      Answer,
    )
    expect(budget).toEqual({ ok: false, error: { kind: 'budget-exceeded', costUsd: 1.2 } })
  })
})
