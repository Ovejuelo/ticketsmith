import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool, reposContext } from '../../core/mcp/index.ts'
import { readFile, validateRepoPath } from '../../core/repos/index.ts'
import { REF_DESCRIPTION, resolveTarget, truncate } from './repo-target.ts'

export const MAX_LINES = 400
const MAX_LINE = 2000

export const readTool = defineTool({
  name: 'repo_read',
  title: 'Read a file of a repository',
  description: `Read a tracked file of a repository with line numbers, to cite file:line. At most ${MAX_LINES} lines per call: pass startLine/endLine for longer files. Only tracked files are readable (never ignored files such as .env).`,
  inputSchema: {
    repo: z.string().describe('Repository name (see repo_list)'),
    path: z.string().min(1).describe('File path relative to the repository root'),
    startLine: z.number().int().min(1).optional().describe('First line (default 1)'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Last line (default startLine + ${MAX_LINES - 1})`),
    ref: z.string().optional().describe(REF_DESCRIPTION),
  },
  requires: ['repos'],
  readOnly: true,
  run: async ({ repo, path, startLine, endLine, ref }, context) => {
    const repos = reposContext(context)
    if (!repos.ok) return repos
    const file = validateRepoPath(path)
    if (!file.ok) return file
    if (file.value === '') return err('Give a file path; list folders with repo_files.')
    const target = await resolveTarget(repos.value, repo, ref)
    if (!target.ok) return target

    const content = await readFile(target.value.repository.dir, target.value.commit.id, file.value)
    if (!content.ok) return content
    if (content.value.kind === 'binary') {
      return err(`${file.value} is a binary file (${content.value.bytes} bytes).`)
    }
    const lines = content.value.text.replace(/\n$/, '').split('\n')
    const first = startLine ?? 1
    if (first > lines.length) return err(`${file.value} has only ${lines.length} lines.`)
    const last = Math.min(endLine ?? first + MAX_LINES - 1, first + MAX_LINES - 1, lines.length)
    if (last < first) return err('endLine must not be before startLine.')
    const width = String(last).length
    const body = lines
      .slice(first - 1, last)
      .map((line, index) => `${String(first + index).padStart(width)}  ${truncate(line, MAX_LINE)}`)
    const more =
      last < lines.length
        ? `\n\n(${lines.length - last} more lines: continue with startLine ${last + 1})`
        : ''
    return ok(
      `${repo}/${file.value} at ${target.value.label}, lines ${first}-${last} of ${lines.length}:\n\n${body.join('\n')}${more}`,
    )
  },
})
