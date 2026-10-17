import type { Feature } from '../../core/feature/index.ts'
import { commentCommand } from './comment.command.ts'
import { getIssueTool } from './get-issue.tool.ts'
import { listCommand } from './list.command.ts'
import { searchTool } from './search.tool.ts'
import { showCommand } from './show.command.ts'
import { transitionCommand } from './transition.command.ts'

/** Tickets: `list`, `show`, the MCP tools jira_get_issue and jira_search (read-only), and `comment` / `transition`, which a person confirms (L2). */
export const ticketsFeature: Feature = {
  name: 'tickets',
  commands: [listCommand, showCommand, commentCommand, transitionCommand],
  tools: [getIssueTool, searchTool],
}
