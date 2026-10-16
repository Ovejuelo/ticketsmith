import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ok, type Result } from '../kernel/index.ts'
import type { ProjectPaths } from '../project/index.ts'
import { branchFor } from './branch-name.ts'
import { addWorktree, mergeBase } from './git.ts'
import { type Repository, syncRepository } from './repositories.ts'

/** A ticket's worktree in one repository. */
export type Worktree = {
  readonly repository: Repository
  readonly dir: string
  readonly branch: string
  /** The fix-branch commit the work started from: diffs and PRs are against it. */
  readonly base: string
}

/** A fix (from the fix branch) or new functionality (from the feature branch). */
export type WorktreeKind = 'fix' | 'feature'

export const worktreeDir = (
  paths: ProjectPaths,
  key: string,
  repo: string,
  kind: WorktreeKind = 'fix',
): string => join(paths.worktreesDir, kind === 'fix' ? key : `${key}-feature`, repo)

/** The branch a kind of change starts from, its name pattern and where its pull request goes. */
export const changeBranches = (config: Repository['config'], kind: WorktreeKind) =>
  kind === 'fix'
    ? {
        base: config.branches.fix,
        pattern: config.branchPattern,
        target: config.prTarget ?? config.branches.fix,
      }
    : {
        base: config.branches.feature,
        pattern: config.featureBranchPattern,
        target: config.featurePrTarget ?? config.branches.feature,
      }

/**
 * The ticket's worktree for a repository: the clone is fetched, then a branch named by the
 * repository's pattern is created from its fix branch (or feature branch for new functionality). An existing worktree is reused, so a second
 * run continues on the same changes.
 */
export const prepareWorktree = async (
  paths: ProjectPaths,
  repository: Repository,
  key: string,
  summary: string,
  kind: WorktreeKind = 'fix',
): Promise<Result<Worktree, string>> => {
  const { base: baseBranch, pattern } = changeBranches(repository.config, kind)
  const branch = branchFor(pattern, key, summary)
  if (!branch.ok) return branch
  const dir = worktreeDir(paths, key, repository.config.name, kind)
  const synced = await syncRepository(repository)
  if (!synced.ok) return synced
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    const added = await addWorktree(
      repository.dir,
      dir,
      branch.value,
      `refs/remotes/origin/${baseBranch}`,
    )
    if (!added.ok) return added
  }
  const base = await mergeBase(dir, `refs/remotes/origin/${baseBranch}`)
  if (!base.ok) return base
  return ok({ repository, dir, branch: branch.value, base: base.value })
}
