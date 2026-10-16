import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool } from '../../core/mcp/index.ts'
import { readKnowledge } from './knowledge-files.ts'

export const MAX_LINES = 500

export const readTool = defineTool({
  name: 'knowledge_read',
  title: 'Read project knowledge',
  description: `Read a Markdown file of the project's knowledge: start with "brief.md", which links the rest (repository maps and analyses, database schemas, ticket-source notes, playbooks, cases). At most ${MAX_LINES} lines per call; pass startLine for long files.`,
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe('Path relative to knowledge/, e.g. "brief.md" or "repos/api.md"'),
    startLine: z.number().int().min(1).optional().describe('First line (default 1)'),
  },
  requires: [],
  readOnly: true,
  run: async ({ path, startLine }, context) => {
    const content = await readKnowledge(context.knowledge.dir, path)
    if (!content.ok) return content
    const lines = content.value.replace(/\n$/, '').split('\n')
    const first = startLine ?? 1
    if (first > lines.length) return err(`${path} has only ${lines.length} lines.`)
    const last = Math.min(first + MAX_LINES - 1, lines.length)
    const more =
      last < lines.length
        ? `\n\n(${lines.length - last} more lines: continue with startLine ${last + 1})`
        : ''
    const header =
      first === 1 && last === lines.length
        ? ''
        : `${path}, lines ${first}-${last} of ${lines.length}:\n\n`
    return ok(`${header}${lines.slice(first - 1, last).join('\n')}${more}`)
  },
})
