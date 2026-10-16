import type { CommandFactory } from '../cli/index.ts'
import type { Tool } from '../mcp/index.ts'

/** A user-facing capability: its CLI commands and MCP tools. Registered in bootstrap/features.ts. */
export type Feature = {
  readonly name: string
  readonly commands: readonly CommandFactory[]
  readonly tools: readonly Tool[]
}
