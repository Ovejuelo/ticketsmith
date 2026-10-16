import type { Feature } from '../../core/feature/index.ts'
import { knowledgeCommand } from './knowledge.command.ts'
import { readTool } from './read.tool.ts'
import { searchTool } from './search.tool.ts'

/** The project's knowledge: `knowledge add <KEY>` (resolved cases) and MCP tools knowledge_read, knowledge_search. */
export const knowledgeFeature: Feature = {
  name: 'knowledge',
  commands: [knowledgeCommand],
  tools: [readTool, searchTool],
}
