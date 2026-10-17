import type {
  AgentError,
  AgentRequest,
  AgentRun,
  AgentRuntime,
  AgentStatus,
} from '#src/core/agent/index.ts'
import { err, ok, type Result } from '#src/core/kernel/index.ts'

type Reply = unknown | AgentError | ((request: AgentRequest) => Promise<unknown> | unknown)

const isAgentError = (value: unknown): value is AgentError =>
  typeof value === 'object' && value !== null && 'kind' in value && !('summary' in value)

/**
 * Scripted agent: each run takes the next reply (the last one repeats). A reply is the structured
 * output, an AgentError, or a function of the request (e.g. one that calls MCP tools first).
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly requests: AgentRequest[] = []
  status: Result<AgentStatus, AgentError> = ok({
    runtime: 'Claude Code',
    version: '2.1.301',
    loggedIn: true,
    authMethod: 'claude.ai',
  })
  #replies: Reply[] = []

  reply(...replies: Reply[]): this {
    this.#replies = replies
    return this
  }

  async run(request: AgentRequest): Promise<Result<AgentRun, AgentError>> {
    this.requests.push(request)
    const reply = this.#replies.length > 1 ? this.#replies.shift() : this.#replies[0]
    const output = typeof reply === 'function' ? await reply(request) : reply
    if (isAgentError(output)) return err(output)
    return ok({
      output,
      costUsd: 0.25,
      turns: 5,
      durationMs: 1000,
      sessionId: `session-${this.requests.length}`,
    })
  }

  async check(): Promise<Result<AgentStatus, AgentError>> {
    return this.status
  }
}
