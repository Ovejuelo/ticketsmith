import type { Feature } from '../../core/feature/index.ts'
import { filesTool } from './files.tool.ts'
import { listTool } from './list.tool.ts'
import { readTool } from './read.tool.ts'
import { searchTool } from './search.tool.ts'

/** Read-only access to the project repositories' clones: MCP tools repo_list, repo_files, repo_search, repo_read. */
export const reposFeature: Feature = {
  name: 'repos',
  commands: [],
  tools: [listTool, filesTool, searchTool, readTool],
}
