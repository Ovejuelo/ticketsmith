import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { defineTool } from '../../core/mcp/index.ts'
import { describeTestRun, runTests } from './run-tests.ts'

export const runTestsTool = defineTool({
  name: 'code_run_tests',
  title: "Run a repository's tests in the ticket worktree",
  description:
    "Run the repository's configured test command in this ticket's worktree and get the exit code and the last lines of output. It is the only way to run anything: there is no shell. Run it before and after your change.",
  inputSchema: {
    repo: z.string().describe('Repository name (one of the worktrees of this session)'),
  },
  requires: ['repos'],
  readOnly: false,
  availableWhen: (context) => (context.code ?? null) !== null,
  run: async ({ repo }, context) => {
    const worktree = context.code?.worktrees.find((candidate) => candidate.repo === repo)
    if (worktree === undefined) {
      return err(
        `No worktree for "${repo}" in this session: ${context.code?.worktrees.map((w) => w.repo).join(', ') ?? 'none'}.`,
      )
    }
    if (worktree.testCommand === undefined) {
      return err(
        `"${repo}" has no test command configured (testCommand in project.yaml): ask the user.`,
      )
    }
    const run = await runTests({
      dir: worktree.dir,
      command: worktree.testCommand,
      node: worktree.node,
      timeoutMs: context.code?.testTimeoutMs ?? 15 * 60_000,
    })
    return ok(describeTestRun(repo, run))
  },
})
