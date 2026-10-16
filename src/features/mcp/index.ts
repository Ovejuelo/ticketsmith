import type { Feature } from '../../core/feature/index.ts'
import { mcpCommand } from './mcp.command.ts'

/** Serve the tools of every feature to MCP clients: `mcp` and `mcp setup`. */
export const mcpFeature: Feature = {
  name: 'mcp',
  commands: [mcpCommand],
  tools: [],
}
