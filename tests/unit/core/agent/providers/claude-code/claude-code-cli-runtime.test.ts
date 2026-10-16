import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest } from '#src/core/agent/index.ts'
import { ClaudeCodeCliRuntime } from '#src/core/agent/providers/claude-code/claude-code-cli-runtime.ts'
import { FakeClaudeBinary } from '#tests/support/install-fake-claude.ts'

const request: AgentRequest = {
  prompt: 'Investigate OPS-1.',
  playbook: '# Playbook',
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  mcpConfig: { mcpServers: { ticketsmith: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } },
  maxBudgetUsd: 3,
  timeoutMs: 20_000,
}

describe('ClaudeCodeCliRuntime', () => {
  let fake: FakeClaudeBinary
  beforeEach(() => {
    fake = new FakeClaudeBinary()
  })
  afterEach(() => fake[Symbol.dispose]())

  const runtime = (scenario: string, output?: unknown) =>
    new ClaudeCodeCliRuntime({ command: fake.command, env: fake.env(scenario, output) })

  it('runs headless with no built-in tools, only the Ticketsmith MCP server, from an empty folder', async () => {
    const result = await runtime('ok', { answer: 'found it' }).run({ ...request, model: 'sonnet' })

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
    const [call] = fake.calls()
    expect(call?.args).toEqual([
      '-p',
      'Investigate OPS-1.',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.outputSchema),
      '--append-system-prompt',
      '# Playbook',
      '--mcp-config',
      JSON.stringify(request.mcpConfig),
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      'mcp__ticketsmith__*',
      '--restricted',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--max-budget-usd',
      '3',
      '--model',
      'sonnet',
    ])
    expect(call?.cwd).toMatch(/ticketsmith-agent-/)
    expect(existsSync(call?.cwd ?? '/')).toBe(false) // removed afterwards
    expect(call?.secretVisible).toBe(false) // TICKETSMITH_* never reach the agent
  })

  it('gives code runs the file tools, confined to the worktrees, and never a shell', async () => {
    const dirs = [fake.dir, `${fake.dir}/../other`]
    await runtime('ok').run({ ...request, workspace: { dirs } })
    const [call] = fake.calls()
    const args = call?.args ?? []
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Edit,Write,Glob,Grep,mcp__ticketsmith__*',
    )
    expect(args).toContain('--restricted')
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual([
      '--add-dir',
      dirs[1],
    ])
    expect(args.join(' ')).not.toMatch(/Bash/)
    expect(call?.cwd).toBe(await import('node:fs').then((fs) => fs.realpathSync(fake.dir)))
    expect(await import('node:fs').then((fs) => fs.existsSync(fake.dir))).toBe(true) // the workspace is kept
  })

  it('reports budget, sign-in, crashes and missing structured answers as errors', async () => {
    expect(await runtime('budget').run(request)).toEqual({
      ok: false,
      error: { kind: 'budget-exceeded', costUsd: 3.1 },
    })
    expect(await runtime('logged-out').run(request)).toEqual({
      ok: false,
      error: { kind: 'not-logged-in' },
    })
    expect(await runtime('crash').run(request)).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'Error: something broke' },
    })
    expect(await runtime('no-structured').run(request)).toEqual({
      ok: false,
      error: { kind: 'invalid-output', issues: 'the agent returned no structured answer' },
    })
  })

  it('stops a session that runs past its time limit', async () => {
    const started = Date.now()
    expect(await runtime('hang').run({ ...request, timeoutMs: 500 })).toEqual({
      ok: false,
      error: { kind: 'timeout', afterMs: 500 },
    })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('explains when Claude Code is not installed', async () => {
    const missing = new ClaudeCodeCliRuntime({ command: '/nonexistent/claude' })
    expect(await missing.run(request)).toEqual({ ok: false, error: { kind: 'not-installed' } })
    expect(await missing.check()).toEqual({ ok: false, error: { kind: 'not-installed' } })
  })

  it('checks the version and the sign-in for doctor', async () => {
    expect(await runtime('ok').check()).toEqual({
      ok: true,
      value: { version: '2.1.301', loggedIn: true, authMethod: 'claude.ai' },
    })
    expect(await runtime('logged-out').check()).toMatchObject({
      ok: true,
      value: { loggedIn: false },
    })
  })
})
