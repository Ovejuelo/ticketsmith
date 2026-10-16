import type { Command } from 'commander'
import type { Result } from '../kernel/index.ts'
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
}

export type CommandFactory = (deps: CommandDeps) => Command

export const globalOptions = (command: Command): GlobalOptions =>
  command.optsWithGlobals<GlobalOptions>()

export const orFail = <T, E>(result: Result<T, E>, describe: (error: E) => string): T =>
  result.ok ? result.value : fail(describe(result.error))
