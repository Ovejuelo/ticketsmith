import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type {
  AgentError,
  AgentRequest,
  AgentRun,
  AgentRuntime,
  AgentStatus,
} from '../../agent-runtime.port.ts'

const KILL_GRACE_MS = 5_000
/** File tools for code changes; --restricted confines them to the workspace. Never Bash. */
const FILE_TOOLS = 'Read,Edit,Write,Glob,Grep'

const ResultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().default(0),
  num_turns: z.number().default(0),
  duration_ms: z.number().default(0),
  session_id: z.string().default(''),
  errors: z.array(z.string()).optional(),
})

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
})

type Exit = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly missing: boolean
}

export type ClaudeCodeCliOptions = {
  /** The Claude Code binary (default `claude` on the PATH). */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
}

const NOT_LOGGED_IN = /not logged in|\/login|invalid api key|authentication/i

/**
 * Runs Claude Code headless with the user's own subscription (the official binary; its token is
 * never read by Ticketsmith). The agent gets no built-in tools at all: only the Ticketsmith MCP
 * server in `mcpConfig`, in restricted mode, from an empty temporary folder so no project's
 * CLAUDE.md or settings leak in.
 */
export class ClaudeCodeCliRuntime implements AgentRuntime {
  readonly #command: string
  readonly #env: NodeJS.ProcessEnv

  constructor(options: ClaudeCodeCliOptions = {}) {
    this.#command = options.command ?? 'claude'
    // The agent process never needs Ticketsmith's own secrets (tools run in this process).
    this.#env = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(
        ([name]) => !name.startsWith('TICKETSMITH_'),
      ),
    )
  }

  /** The exact arguments, exported for tests and for `--verbose` diagnostics. */
  static args(request: AgentRequest): string[] {
    const dirs = request.workspace?.dirs ?? []
    return [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.outputSchema),
      '--append-system-prompt',
      request.playbook,
      '--mcp-config',
      JSON.stringify(request.mcpConfig),
      '--strict-mcp-config',
      '--tools',
      dirs.length === 0 ? '' : FILE_TOOLS,
      '--allowedTools',
      dirs.length === 0 ? 'mcp__ticketsmith__*' : `${FILE_TOOLS},mcp__ticketsmith__*`,
      ...dirs.slice(1).flatMap((dir) => ['--add-dir', dir]),
      '--restricted',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--max-budget-usd',
      String(request.maxBudgetUsd),
      ...(request.model === undefined ? [] : ['--model', request.model]),
    ]
  }

  async run(request: AgentRequest): Promise<Result<AgentRun, AgentError>> {
    const workspace = request.workspace?.dirs[0]
    const cwd = workspace ?? (await mkdtemp(join(tmpdir(), 'ticketsmith-agent-')))
    try {
      const exit = await this.#exec(ClaudeCodeCliRuntime.args(request), cwd, request.timeoutMs)
      if (exit.missing) return err({ kind: 'not-installed' })
      if (exit.timedOut) return err({ kind: 'timeout', afterMs: request.timeoutMs })
      return parseResult(exit)
    } finally {
      if (workspace === undefined) await rm(cwd, { recursive: true, force: true })
    }
  }

  async check(): Promise<Result<AgentStatus, AgentError>> {
    const cwd = tmpdir()
    const version = await this.#exec(['--version'], cwd, 30_000)
    if (version.missing) return err({ kind: 'not-installed' })
    if (version.code !== 0)
      return err({ kind: 'failed', message: version.stderr.trim() || 'claude --version failed' })
    const auth = await this.#exec(['auth', 'status'], cwd, 30_000)
    const parsed = (() => {
      try {
        return AuthStatusSchema.safeParse(JSON.parse(auth.stdout))
      } catch {
        return null
      }
    })()
    return ok({
      version: version.stdout.trim().split(/\s/)[0] ?? version.stdout.trim(),
      loggedIn: parsed?.success === true ? parsed.data.loggedIn : false,
      authMethod: parsed?.success === true ? parsed.data.authMethod : undefined,
    })
  }

  #exec(args: readonly string[], cwd: string, timeoutMs: number): Promise<Exit> {
    return new Promise((resolve) => {
      const child = spawn(this.#command, [...args], {
        cwd,
        env: this.#env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
      }, timeoutMs)
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve({
          code: null,
          stdout,
          stderr: error.message,
          timedOut,
          missing: error.code === 'ENOENT',
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut, missing: false })
      })
    })
  }
}

const parseResult = (exit: Exit): Result<AgentRun, AgentError> => {
  let json: unknown
  try {
    json = JSON.parse(exit.stdout)
  } catch {
    const message =
      (exit.stderr || exit.stdout).trim().slice(0, 500) || `claude exited with code ${exit.code}`
    return err(
      NOT_LOGGED_IN.test(message) ? { kind: 'not-logged-in' } : { kind: 'failed', message },
    )
  }
  const parsed = ResultSchema.safeParse(json)
  if (!parsed.success) return err({ kind: 'failed', message: 'unexpected output from claude' })
  const result = parsed.data
  if (result.subtype === 'error_max_budget_usd') {
    return err({ kind: 'budget-exceeded', costUsd: result.total_cost_usd })
  }
  if (result.is_error || result.subtype !== 'success') {
    const message = [result.result, ...(result.errors ?? []), exit.stderr.trim()]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .join(' ')
      .slice(0, 500)
    return err(
      NOT_LOGGED_IN.test(message)
        ? { kind: 'not-logged-in' }
        : { kind: 'failed', message: message || result.subtype },
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
