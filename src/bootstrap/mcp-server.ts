import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AuditLog } from '../core/audit/index.ts'
import { err, type Result } from '../core/kernel/index.ts'
import { isToolAvailable, type Tool, type ToolContext } from '../core/mcp/index.ts'
import type { Integration } from '../core/project/index.ts'
import { type MaskingOptions, PlaceholderVault } from '../core/security/index.ts'

export type McpServerDeps = {
  readonly project: string
  readonly tools: readonly Tool[]
  /** Only tools whose required integrations are all configured get registered. */
  readonly integrations: readonly Integration[]
  readonly context: Omit<ToolContext, 'resolvePlaceholders'>
  readonly masking: MaskingOptions
  readonly audit: AuditLog
  readonly version: string
  readonly clock?: () => number
  /** Share the session vault with the caller (e.g. to reveal an agent's answer locally). */
  readonly vault?: PlaceholderVault
}

const MASKING_NOTE =
  'Sensitive values (emails, phones, RFC/CURP, CLABE, cards, secrets) are replaced with placeholders such as [EMAIL_1] or [EMAIL_1]@company.com; a placeholder means the same value for the whole session. Do not try to recover them: pass placeholders as-is in tool inputs (e.g. JQL) and the server substitutes the real values.'

/**
 * Registers the features' tools and wraps every call with masking and auditing, so no tool can
 * skip either. One placeholder vault per server process, i.e. per client session; never persisted.
 */
export const createMcpServer = (deps: McpServerDeps): McpServer => {
  const server = new McpServer(
    { name: 'ticketsmith', version: deps.version },
    {
      instructions: `Tools for the "${deps.project}" project. ${MASKING_NOTE}`,
    },
  )
  const vault = deps.vault ?? new PlaceholderVault()
  const context: ToolContext = {
    ...deps.context,
    resolvePlaceholders: (text) => vault.resolve(text),
  }
  const clock = deps.clock ?? Date.now

  for (const tool of deps.tools.filter((tool) =>
    isToolAvailable(tool, deps.integrations, deps.context),
  )) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description} ${MASKING_NOTE}`,
        inputSchema: tool.inputSchema,
        annotations: tool.readOnly
          ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
          : { readOnlyHint: false, openWorldHint: true },
      },
      async (input: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
        const started = clock()
        let result: Result<string, string>
        try {
          result = await tool.run(input, context)
        } catch (error) {
          result = err(`Internal error: ${String(error)}`)
        }

        // Errors can echo user input (JQL, keys), so they are masked too.
        const masked = vault.mask(result.ok ? result.value : result.error, deps.masking)
        await deps.audit.record({
          tool: tool.name,
          input: Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
          ),
          ok: result.ok,
          ...(result.ok ? {} : { error: masked.text }),
          durationMs: clock() - started,
          output: { chars: masked.text.length, masked: masked.counts },
        })
        return {
          content: [{ type: 'text', text: masked.text }],
          ...(result.ok ? {} : { isError: true }),
        }
      },
    )
  }
  return server
}
