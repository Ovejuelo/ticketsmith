import type { Feature } from '../../core/feature/index.ts'
import { getIssueTool } from './get-issue.tool.ts'
import { listCommand } from './list.command.ts'
import { searchTool } from './search.tool.ts'
import { showCommand } from './show.command.ts'

/** Read tickets: `list`, `show` and the MCP tools jira_get_issue and jira_search. */
export const ticketsFeature: Feature = {
  name: 'tickets',
  commands: [listCommand, showCommand],
  tools: [getIssueTool, searchTool],
}
