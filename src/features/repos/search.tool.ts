import { z } from 'zod'
import { ok } from '../../core/kernel/index.ts'
import { defineTool, reposContext, unknownPlaceholdersMessage } from '../../core/mcp/index.ts'
import { grep, validateRepoPath } from '../../core/repos/index.ts'
import { REF_DESCRIPTION, resolveTarget, truncate } from './repo-target.ts'

export const DEFAULT_RESULTS = 100
export const MAX_RESULTS = 200
const MAX_LINE = 300

export const searchTool = defineTool({
  name: 'repo_search',
  title: 'Search code in the repositories',
  description: `Search the tracked code of one repository, or all of them, like \`git grep\`: returns repo:file:line: text. The pattern is a fixed string unless regex is true (extended regex). At most ${MAX_RESULTS} matches; narrow with path. Read the surrounding code with repo_read.`,
  inputSchema: {
    pattern: z
      .string()
      .min(1)
      .max(500)
      .describe('Text to find (or an extended regex with regex: true)'),
    repo: z.string().optional().describe('Repository name (default: every repository)'),
    path: z.string().optional().describe('Only under this folder or file'),
    regex: z.boolean().optional().describe('Treat the pattern as an extended regular expression'),
    ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
    ref: z.string().optional().describe(REF_DESCRIPTION),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .optional()
      .describe(`Maximum matches (default ${DEFAULT_RESULTS})`),
  },
  requires: ['repos'],
  readOnly: true,
  run: async (input, context) => {
    const repos = reposContext(context)
    if (!repos.ok) return repos
    const pattern = context.resolvePlaceholders(input.pattern)
    if (!pattern.ok) return { ok: false, error: unknownPlaceholdersMessage(pattern.error) }
    const path = validateRepoPath(input.path ?? '')
    if (!path.ok) return path

    const names =
      input.repo === undefined ? repos.value.repositories.map((r) => r.config.name) : [input.repo]
    const limit = input.maxResults ?? DEFAULT_RESULTS
    const lines: string[] = []
    const notes: string[] = []
    let total = 0
    for (const name of names) {
      const target = await resolveTarget(repos.value, name, input.ref)
      if (!target.ok) {
        if (input.repo !== undefined) return target
        notes.push(`${name}: ${target.error}`)
        continue
      }
      const matches = await grep(target.value.repository.dir, {
        pattern: pattern.value,
        regex: input.regex ?? false,
        ignoreCase: input.ignoreCase ?? false,
        commit: target.value.commit.id,
        path: path.value,
      })
      if (!matches.ok) {
        if (input.repo !== undefined) return matches
        notes.push(`${name}: ${matches.error}`)
        continue
      }
      total += matches.value.length
      for (const match of matches.value) {
        if (lines.length >= limit) break
        lines.push(`${name}:${match.path}:${match.line}: ${truncate(match.text.trim(), MAX_LINE)}`)
      }
    }
    const header =
      total === 0
        ? `No matches for "${input.pattern}".`
        : `${total} matches for "${input.pattern}"${total > lines.length ? ` (showing ${lines.length}; narrow with repo or path)` : ''}:`
    return ok(
      [
        header,
        ...(lines.length > 0 ? ['', ...lines] : []),
        ...(notes.length > 0 ? ['', ...notes] : []),
      ].join('\n'),
    )
  },
})
