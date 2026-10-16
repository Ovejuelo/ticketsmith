import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool, reposContext } from '../../core/mcp/index.ts'
import { listFiles, validateRepoPath } from '../../core/repos/index.ts'
import { globToRegExp } from './glob.ts'
import { REF_DESCRIPTION, resolveTarget } from './repo-target.ts'

export const MAX_FILES = 500

export const filesTool = defineTool({
  name: 'repo_files',
  title: 'List files of a repository',
  description: `List the tracked files of a repository, optionally under a folder and/or matching a glob (e.g. "**/*.sql", "src/routes/*.js"). At most ${MAX_FILES} paths per call.`,
  inputSchema: {
    repo: z.string().describe('Repository name (see repo_list)'),
    path: z.string().optional().describe('Folder relative to the repository root'),
    glob: z.string().max(200).optional().describe('Glob on the file path, e.g. "**/*.test.js"'),
    ref: z.string().optional().describe(REF_DESCRIPTION),
  },
  requires: ['repos'],
  readOnly: true,
  run: async ({ repo, path, glob, ref }, context) => {
    const repos = reposContext(context)
    if (!repos.ok) return repos
    const folder = validateRepoPath(path ?? '')
    if (!folder.ok) return folder
    const target = await resolveTarget(repos.value, repo, ref)
    if (!target.ok) return target
    const files = await listFiles(target.value.repository.dir, target.value.commit.id, folder.value)
    if (!files.ok) return files
    const pattern = glob === undefined ? null : globToRegExp(glob)
    const matching = files.value.filter((file) => pattern === null || pattern.test(file))
    if (matching.length === 0) {
      return err(
        `No tracked files${folder.value ? ` under ${folder.value}` : ''}${glob ? ` matching ${glob}` : ''} in ${repo} at ${target.value.label}.`,
      )
    }
    const shown = matching.slice(0, MAX_FILES)
    const more =
      matching.length > shown.length
        ? `\n\n…and ${matching.length - shown.length} more: narrow it with path or glob.`
        : ''
    return ok(
      `${matching.length} files in ${repo} at ${target.value.label}${folder.value ? ` under ${folder.value}/` : ''}:\n\n${shown.join('\n')}${more}`,
    )
  },
})
