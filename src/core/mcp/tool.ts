import { z } from 'zod'
import type { TableInfo } from '../database/index.ts'
import { err, ok, type Result } from '../kernel/index.ts'
import type { Integration } from '../project/index.ts'
import type { DatabaseConnections } from '../services/index.ts'
import type { TicketSource } from '../tickets/index.ts'

export type TicketsToolContext = {
  readonly source: TicketSource
  /** The project's JQL, for tools that search without an explicit query. */
  readonly defaultJql: string | undefined
}

export type DatabasesToolContext = {
  readonly connections: DatabaseConnections
  /** Investigated tables of a target (group or ungrouped database) from the local catalog. */
  tables(target: string): Promise<Result<readonly TableInfo[], string>>
}

/** What every MCP tool can use; built per session by bootstrap/mcp-server.ts. */
export type ToolContext = {
  /** Null when the project has no ticket source (tools requiring it are not registered then). */
  readonly tickets: TicketsToolContext | null
  /** Null when the project has no databases. */
  readonly databases: DatabasesToolContext | null
  /** Turns session placeholders ([EMAIL_1]) back into real values; fails on unknown ones. */
  resolvePlaceholders(text: string): Result<string, readonly string[]>
}

/**
 * An MCP tool as features define it: no SDK types, no masking or auditing (the server wraps
 * every tool with both). `run` returns the plain-text answer or a user-facing error message.
 */
export type Tool = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: z.ZodRawShape
  /** The tool is only offered when the project has all these integrations configured. */
  readonly requires: readonly Integration[]
  /** Read-only tools are annotated as such; write tools must go through human approval. */
  readonly readOnly: boolean
  run(input: unknown, context: ToolContext): Promise<Result<string, string>>
}

type ToolSpec<Shape extends z.ZodRawShape> = Omit<Tool, 'inputSchema' | 'run'> & {
  readonly inputSchema: Shape
  run(input: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<Result<string, string>>
}

/** Keeps `run` typed from the input schema while exposing a uniform `Tool`. */
export const defineTool = <Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): Tool => ({
  ...spec,
  run: (input, context) => spec.run(z.object(spec.inputSchema).parse(input), context),
})

/** True when every integration the tool needs is configured. */
export const isToolAvailable = (tool: Tool, configured: readonly Integration[]): boolean =>
  tool.requires.every((integration) => configured.includes(integration))

export const ticketsContext = (context: ToolContext): Result<TicketsToolContext, string> =>
  context.tickets === null
    ? err('This project has no ticket source configured.')
    : ok(context.tickets)

export const databasesContext = (context: ToolContext): Result<DatabasesToolContext, string> =>
  context.databases === null
    ? err('This project has no databases configured.')
    : ok(context.databases)

export const unknownPlaceholdersMessage = (placeholders: readonly string[]): string =>
  `Unknown placeholder(s) ${placeholders.join(', ')}: use only placeholders returned by this server in this session.`
