import type { Result } from '../kernel/index.ts'

/** How the agent reaches Ticketsmith's tools: an MCP client config (`{ mcpServers: … }`). */
export type McpConfig = { readonly mcpServers: Readonly<Record<string, unknown>> }

export type AgentRequest = {
  readonly prompt: string
  /** Instructions appended to the agent's system prompt. */
  readonly playbook: string
  /** JSON Schema the final answer must follow. */
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly mcpConfig: McpConfig
  readonly model?: string | undefined
  readonly maxBudgetUsd: number
  readonly timeoutMs: number
}

export type AgentRun = {
  /** The structured answer, still unvalidated against the caller's zod schema. */
  readonly output: unknown
  readonly costUsd: number
  readonly turns: number
  readonly durationMs: number
  readonly sessionId: string
}

export type AgentError =
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'not-logged-in' }
  | { readonly kind: 'timeout'; readonly afterMs: number }
  | { readonly kind: 'budget-exceeded'; readonly costUsd: number }
  | { readonly kind: 'invalid-output'; readonly issues: string }
  | { readonly kind: 'failed'; readonly message: string }

export type AgentStatus = {
  readonly version: string
  readonly loggedIn: boolean
  readonly authMethod: string | undefined
}

/** Runs one agent session to a structured answer. v1: Claude Code headless; later: the Agent SDK. */
export interface AgentRuntime {
  run(request: AgentRequest): Promise<Result<AgentRun, AgentError>>
  /** Whether the agent is installed and signed in (for `doctor`). */
  check(): Promise<Result<AgentStatus, AgentError>>
}

export const describeAgentError = (error: AgentError): string => {
  switch (error.kind) {
    case 'not-installed':
      return 'Claude Code is not installed: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in.'
    case 'not-logged-in':
      return 'Claude Code is not signed in: run `claude` and log in.'
    case 'timeout':
      return `The agent did not finish within ${Math.round(error.afterMs / 60_000)} minutes (raise agent.timeoutMinutes in project.yaml).`
    case 'budget-exceeded':
      return `The agent reached its budget ($${error.costUsd.toFixed(2)} spent; raise it with --budget or agent.maxBudgetUsd).`
    case 'invalid-output':
      return `The agent's answer did not have the expected shape: ${error.issues}`
    case 'failed':
      return `The agent failed: ${error.message}`
  }
}
