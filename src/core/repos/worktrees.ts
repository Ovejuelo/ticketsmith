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

export const worktreeDir = (paths: ProjectPaths, key: string, repo: string): string =>
  join(paths.worktreesDir, key, repo)

/**
 * The ticket's worktree for a repository: the clone is fetched, then a branch named by the
 * repository's pattern is created from its fix branch. An existing worktree is reused, so a second
 * run continues on the same changes.
 */
export const prepareWorktree = async (
  paths: ProjectPaths,
  repository: Repository,
  key: string,
  summary: string,
): Promise<Result<Worktree, string>> => {
  const branch = branchFor(repository.config.branchPattern, key, summary)
  if (!branch.ok) return branch
  const dir = worktreeDir(paths, key, repository.config.name)
  const synced = await syncRepository(repository)
  if (!synced.ok) return synced
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    const added = await addWorktree(
      repository.dir,
      dir,
      branch.value,
      `refs/remotes/origin/${repository.config.branches.fix}`,
    )
    if (!added.ok) return added
  }
  const base = await mergeBase(dir, `refs/remotes/origin/${repository.config.branches.fix}`)
  if (!base.ok) return base
  return ok({ repository, dir, branch: branch.value, base: base.value })
}
