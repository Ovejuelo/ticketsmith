import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpServerConfig, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type {
  AgentError,
  AgentRequest,
  AgentRun,
  AgentRuntime,
  AgentStatus,
} from '../../agent-runtime.port.ts'

/** File tools for code changes, confined to the workspace like the CLI runtime's. Never Bash. */
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The SDK's `query`, injectable so tests never start a real agent. */
export type SdkQuery = (params: {
  readonly prompt: string
  readonly options: Options
}) => AsyncIterable<SDKMessage>

export type AgentSdkOptions = {
  /** The Anthropic API key, read only when a run starts (keychain or environment). */
  readonly apiKey: () => Promise<string | null>
  /** Defaults to the installed SDK, loaded on first use (it is an optional dependency). */
  readonly query?: SdkQuery
  readonly env?: NodeJS.ProcessEnv
}

const ResultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().default(false),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().default(0),
  num_turns: z.number().default(0),
  duration_ms: z.number().default(0),
  session_id: z.string().default(''),
  errors: z.array(z.string()).optional(),
})

const AUTH_FAILURE = /invalid api key|authentication|x-api-key|401/i

/**
 * Runs the agent through the Claude Agent SDK with an API key, for unattended runs (CI, evals)
 * where nobody is signed in to Claude Code. Same guarantees as the CLI runtime: only the
 * Ticketsmith MCP server (plus confined file tools for code changes), no shell, no settings or
 * CLAUDE.md from disk, nothing persisted, a structured answer, a budget and a time limit.
 */
export class AgentSdkRuntime implements AgentRuntime {
  readonly #apiKey: () => Promise<string | null>
  readonly #query: SdkQuery | undefined
  readonly #env: NodeJS.ProcessEnv

  constructor(options: AgentSdkOptions) {
    this.#apiKey = options.apiKey
    this.#query = options.query
    // The agent process never needs Ticketsmith's own secrets (tools run in this process).
    this.#env = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(
        ([name]) => !name.startsWith('TICKETSMITH_') && name !== 'ANTHROPIC_API_KEY',
      ),
    )
  }

  /** The exact SDK options, exported for tests. */
  static options(
    request: AgentRequest,
    context: { readonly cwd: string; readonly apiKey: string; readonly env: NodeJS.ProcessEnv },
    abortController: AbortController,
  ): Options {
    const dirs = request.workspace?.dirs ?? []
    return {
      cwd: context.cwd,
      additionalDirectories: dirs.slice(1),
      tools: dirs.length === 0 ? [] : FILE_TOOLS,
      allowedTools: [...(dirs.length === 0 ? [] : FILE_TOOLS), 'mcp__ticketsmith__*'],
      mcpServers: request.mcpConfig.mcpServers as Record<string, McpServerConfig>,
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: request.playbook },
      outputFormat: { type: 'json_schema', schema: { ...request.outputSchema } },
      maxBudgetUsd: request.maxBudgetUsd,
      ...(request.model === undefined ? {} : { model: request.model }),
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      settingSources: [],
      persistSession: false,
      extraArgs: { restricted: null, 'disable-slash-commands': null },
      env: { ...context.env, ANTHROPIC_API_KEY: context.apiKey },
      abortController,
    }
  }

  async run(request: AgentRequest): Promise<Result<AgentRun, AgentError>> {
    const apiKey = await this.#apiKey()
    if (apiKey === null) return err({ kind: 'no-api-key' })
    const query = await this.#loadQuery()
    if (query === null) return err({ kind: 'sdk-missing' })

    const workspace = request.workspace?.dirs[0]
    const cwd = workspace ?? (await mkdtemp(join(tmpdir(), 'ticketsmith-agent-')))
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, request.timeoutMs)
    try {
      let result: unknown
      for await (const message of query({
        prompt: request.prompt,
        options: AgentSdkRuntime.options(request, { cwd, apiKey, env: this.#env }, abort),
      })) {
        if (message.type === 'result') result = message
      }
      if (timedOut) return err({ kind: 'timeout', afterMs: request.timeoutMs })
      return parseResult(result)
    } catch (error) {
      if (timedOut) return err({ kind: 'timeout', afterMs: request.timeoutMs })
      const message = error instanceof Error ? error.message : String(error)
      return err(AUTH_FAILURE.test(message) ? { kind: 'no-api-key' } : { kind: 'failed', message })
    } finally {
      clearTimeout(timer)
      if (workspace === undefined) await rm(cwd, { recursive: true, force: true })
    }
  }

  async check(): Promise<Result<AgentStatus, AgentError>> {
    if ((await this.#loadQuery()) === null) return err({ kind: 'sdk-missing' })
    const apiKey = await this.#apiKey()
    return ok({
      runtime: 'Claude Agent SDK',
      version: await sdkVersion(),
      loggedIn: apiKey !== null,
      authMethod: apiKey === null ? undefined : 'API key',
    })
  }

  async #loadQuery(): Promise<SdkQuery | null> {
    if (this.#query !== undefined) return this.#query
    try {
      const sdk = await import(SDK_PACKAGE)
      return sdk.query as SdkQuery
    } catch {
      return null
    }
  }
}

const sdkVersion = async (): Promise<string> => {
  try {
    // The package does not export its package.json; it sits next to the entry point.
    const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE)
    const manifest = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')) as {
      version?: string
    }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const parseResult = (message: unknown): Result<AgentRun, AgentError> => {
  if (message === undefined) return err({ kind: 'failed', message: 'the agent sent no result' })
  const parsed = ResultSchema.safeParse(message)
  if (!parsed.success) return err({ kind: 'failed', message: 'unexpected result from the SDK' })
  const result = parsed.data
  if (result.subtype === 'error_max_budget_usd') {
    return err({ kind: 'budget-exceeded', costUsd: result.total_cost_usd })
  }
  if (result.is_error || result.subtype !== 'success') {
    const text = [result.result, ...(result.errors ?? [])]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .join(' ')
      .slice(0, 500)
    return err(
      AUTH_FAILURE.test(text)
        ? { kind: 'no-api-key' }
        : { kind: 'failed', message: text || result.subtype },
    )
  }
  if (result.structured_output === undefined) {
    return err({ kind: 'invalid-output', issues: 'the agent returned no structured answer' })
  }
  return ok({
    output: result.structured_output,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: result.duration_ms,
    sessionId: result.session_id,
  })
}
