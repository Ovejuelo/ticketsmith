import type { Feature } from '../../core/feature/index.ts'
import { dbCommand } from './ask.command.ts'
import { schemaTool } from './schema.tool.ts'
import { selectTool } from './select.tool.ts'
import { selectGroupTool } from './select-group.tool.ts'

/** Read-only access to the project databases: `db ask` and the MCP tools db_select, db_select_group, db_schema. */
export const databasesFeature: Feature = {
  name: 'databases',
  commands: [dbCommand],
  tools: [selectTool, selectGroupTool, schemaTool],
}
