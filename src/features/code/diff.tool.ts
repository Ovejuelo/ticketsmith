import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool } from '../../core/mcp/index.ts'
import { workingDiff } from '../../core/repos/index.ts'

const MAX_CHARS = 100_000

export const diffTool = defineTool({
  name: 'code_diff',
  title: 'Show the changes made so far in a ticket worktree',
  description:
    'The uncommitted changes (new files included) of one repository in this ticket worktree, as a unified diff.',
  inputSchema: {
    repo: z.string().describe('Repository name (one of the worktrees of this session)'),
  },
  requires: ['repos'],
  readOnly: true,
  availableWhen: (context) => (context.code ?? null) !== null,
  run: async ({ repo }, context) => {
    const worktree = context.code?.worktrees.find((candidate) => candidate.repo === repo)
    if (worktree === undefined) return err(`No worktree for "${repo}" in this session.`)
    const diff = await workingDiff(worktree.dir)
    if (!diff.ok) return diff
    if (diff.value.trim() === '') return ok(`No changes in ${repo} yet.`)
    return ok(
      diff.value.length > MAX_CHARS
        ? `${diff.value.slice(0, MAX_CHARS)}\n… (diff truncated)`
        : diff.value,
    )
  },
})
