import type { Feature } from '../../core/feature/index.ts'
import { readTool } from './read.tool.ts'
import { searchTool } from './search.tool.ts'

/** The project's knowledge for the agent: MCP tools knowledge_read and knowledge_search. */
export const knowledgeFeature: Feature = {
  name: 'knowledge',
  commands: [],
  tools: [readTool, searchTool],
}
