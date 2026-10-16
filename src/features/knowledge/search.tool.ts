import { z } from 'zod'
import { ok } from '../../core/kernel/index.ts'
import { defineTool, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import { listKnowledge, readKnowledge } from './knowledge-files.ts'

export const MAX_RESULTS = 100
const MAX_LINE = 300

export const searchTool = defineTool({
  name: 'knowledge_search',
  title: 'Search project knowledge',
  description: `Search every Markdown file of the project's knowledge (case-insensitive text): returns file:line: text, at most ${MAX_RESULTS} matches. Read the file around a match with knowledge_read.`,
  inputSchema: {
    query: z
      .string()
      .min(2)
      .max(200)
      .describe('Text to find, e.g. a table, endpoint or domain term'),
  },
  requires: [],
  readOnly: true,
  run: async ({ query }, context) => {
    const resolved = context.resolvePlaceholders(query)
    if (!resolved.ok) return { ok: false, error: unknownPlaceholdersMessage(resolved.error) }
    const needle = resolved.value.toLowerCase()
    const files = await listKnowledge(context.knowledge.dir)
    const matches: string[] = []
    let total = 0
    for (const file of files) {
      const content = await readKnowledge(context.knowledge.dir, file)
      if (!content.ok) continue
      content.value.split('\n').forEach((line, index) => {
        if (!line.toLowerCase().includes(needle)) return
        total++
        if (matches.length < MAX_RESULTS) {
          const text = line.trim()
          matches.push(
            `${file}:${index + 1}: ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text}`,
          )
        }
      })
    }
    if (files.length === 0)
      return ok('This project has no knowledge yet: run `ticketsmith project refresh`.')
    return ok(
      total === 0
        ? `No matches for "${query}" in ${files.length} knowledge files.`
        : `${total} matches for "${query}"${total > matches.length ? ` (showing ${matches.length})` : ''}:\n\n${matches.join('\n')}`,
    )
  },
})
