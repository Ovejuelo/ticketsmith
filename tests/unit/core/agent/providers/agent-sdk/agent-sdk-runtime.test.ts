import { existsSync } from 'node:fs'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { AgentRequest } from '#src/core/agent/index.ts'
import { AgentSdkRuntime, type SdkQuery } from '#src/core/agent/providers/agent-sdk/index.ts'

const request: AgentRequest = {
  prompt: 'Investigate OPS-1.',
  playbook: '# Playbook',
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  mcpConfig: { mcpServers: { ticketsmith: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } },
  maxBudgetUsd: 3,
  timeoutMs: 20_000,
}

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  structured_output: { answer: 'found it' },
  total_cost_usd: 0.42,
  num_turns: 7,
  duration_ms: 12_345,
  session_id: 'session-1',
}

/** A scripted SDK: records the options and yields the given messages. */
const fakeQuery = (messages: readonly unknown[], seen: Options[] = []): SdkQuery =>
  async function* ({ options }) {
    seen.push(options)
    for (const message of messages) yield message as SDKMessage
  }

const runtime = (query: SdkQuery, apiKey: string | null = 'sk-test') =>
  new AgentSdkRuntime({
    apiKey: async () => apiKey,
    query,
    env: { PATH: '/bin', TICKETSMITH_DB_SHARD1: 'secret', ANTHROPIC_API_KEY: 'other' },
  })

describe('AgentSdkRuntime', () => {
  it('runs with no built-in tools, only the Ticketsmith MCP server, isolated from disk settings', async () => {
    const seen: Options[] = []
    const result = await runtime(fakeQuery([{ type: 'system' }, success], seen)).run({
      ...request,
      model: 'sonnet',
    })

    expect(result).toEqual({
      ok: true,
      value: {
        output: { answer: 'found it' },
        costUsd: 0.42,
        turns: 7,
        durationMs: 12_345,
        sessionId: 'session-1',
      },
    })
    const [options] = seen
    expect(options).toMatchObject({
      tools: [],
      allowedTools: ['mcp__ticketsmith__*'],
      additionalDirectories: [],
      mcpServers: request.mcpConfig.mcpServers,
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '# Playbook' },
      outputFormat: { type: 'json_schema', schema: request.outputSchema },
      maxBudgetUsd: 3,
      model: 'sonnet',
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      settingSources: [],
      persistSession: false,
      extraArgs: { restricted: null, 'disable-slash-commands': null },
    })
    // Ticketsmith's own secrets never reach the agent process; only the API key is passed.
    expect(options?.env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test' })
    // It ran from an empty temporary folder, removed afterwards.
    expect(options?.cwd).toMatch(/ticketsmith-agent-/)
    expect(existsSync(options?.cwd ?? '')).toBe(false)
  })

  it('confines code runs to the workspace with file tools, never Bash', async () => {
    const seen: Options[] = []
    await runtime(fakeQuery([success], seen)).run({
      ...request,
      workspace: { dirs: ['/w/api', '/w/web'] },
    })
    expect(seen[0]).toMatchObject({
      cwd: '/w/api',
      additionalDirectories: ['/w/web'],
      tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__ticketsmith__*'],
    })
  })

  it('maps budget, failure, missing output and a missing API key', async () => {
    expect(
      await runtime(
        fakeQuery([{ ...success, subtype: 'error_max_budget_usd', is_error: true }]),
      ).run(request),
    ).toEqual({ ok: false, error: { kind: 'budget-exceeded', costUsd: 0.42 } })
    expect(
      await runtime(
        fakeQuery([
          { ...success, subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
        ]),
      ).run(request),
    ).toEqual({ ok: false, error: { kind: 'failed', message: 'boom' } })
    expect(
      await runtime(fakeQuery([{ ...success, structured_output: undefined }])).run(request),
    ).toMatchObject({ ok: false, error: { kind: 'invalid-output' } })

    let called = false
    const never: SdkQuery = async function* () {
      called = true
      yield* []
    }
    expect(await runtime(never, null).run(request)).toEqual({
      ok: false,
      error: { kind: 'no-api-key' },
    })
    expect(called).toBe(false)
  })

  it('stops the run at the time limit', async () => {
    const hangs: SdkQuery = async function* ({ options }) {
      await new Promise((_, reject) =>
        options.abortController?.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      )
      yield* []
    }
    expect(await runtime(hangs).run({ ...request, timeoutMs: 20 })).toEqual({
      ok: false,
      error: { kind: 'timeout', afterMs: 20 },
    })
  })

  it('reports the SDK version and whether a key is configured', async () => {
    expect(await runtime(fakeQuery([])).check()).toMatchObject({
      ok: true,
      value: { runtime: 'Claude Agent SDK', loggedIn: true, authMethod: 'API key' },
    })
    expect(await runtime(fakeQuery([]), null).check()).toMatchObject({
      ok: true,
      value: { loggedIn: false },
    })
    const status = await runtime(fakeQuery([])).check()
    expect(status.ok && status.value.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
