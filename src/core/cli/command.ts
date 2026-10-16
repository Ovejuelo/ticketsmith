import type { Command } from 'commander'
import type { McpConfig } from '../agent/index.ts'
import type { AuditLog } from '../audit/index.ts'
import type { Result } from '../kernel/index.ts'
import type { CodeToolContext } from '../mcp/index.ts'
import type { Services } from '../services/index.ts'
import { fail, type Io } from './io.ts'

export type GlobalOptions = {
  readonly project?: string
  readonly json: boolean
  readonly verbose: boolean
}

/** Where this CLI runs from; used to print the exact command for MCP clients. */
export type Runtime = {
  readonly execPath: string
  readonly scriptPath: string
}

/** Everything a command receives from bootstrap/cli.ts. */
export type CommandDeps = {
  readonly io: Io
  readonly version: string
  readonly runtime: Runtime
  /** Lazily builds services once per run, using the global options of the invoked command. */
  readonly servicesFor: (command: Command) => Services
  /** Runs the MCP server over stdio until the client disconnects. */
  readonly serveMcp: (command: Command) => Promise<void>
  /** Starts the project's tools on a private local HTTP endpoint for one agent run. */
  readonly startAgentToolServer: (
    command: Command,
    options: AgentToolServerOptions,
  ) => Promise<AgentToolServer>
}

export type AgentToolServerOptions = {
  /** The audit file is named after it, e.g. `process`. */
  readonly auditCommand: string
  /** Only these tools (default: every tool the project's integrations allow). */
  readonly only?: (toolName: string) => boolean
  /** Code-change sessions: the ticket's worktrees (enables code_run_tests and code_diff). */
  readonly code?: CodeToolContext
}

/** The project's tools served to one agent session; the placeholder vault lives here, in memory. */
export type AgentToolServer = {
  readonly mcpConfig: McpConfig
  /** Real values back into the agent's answer, for local files only; secrets stay masked. */
  reveal(text: string): string
  /** How many times each tool was called. */
  toolCalls(): Readonly<Record<string, number>>
  /** Adds an entry (e.g. the agent run itself) to this run's audit file. */
  record: AuditLog['record']
  close(): Promise<void>
}

export type CommandFactory = (deps: CommandDeps) => Command

export const globalOptions = (command: Command): GlobalOptions =>
  command.optsWithGlobals<GlobalOptions>()

export const orFail = <T, E>(result: Result<T, E>, describe: (error: E) => string): T =>
  result.ok ? result.value : fail(describe(result.error))
