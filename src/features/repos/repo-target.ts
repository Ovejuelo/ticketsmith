import { ok, type Result } from '../../core/kernel/index.ts'
import type { ReposToolContext } from '../../core/mcp/index.ts'
import {
  type Commit,
  findRepository,
  type Repository,
  resolveCommit,
} from '../../core/repos/index.ts'

export type RepoTarget = {
  readonly repository: Repository
  readonly commit: Commit
  /** How the ref reads in answers: `main (1a2b3c4)`. */
  readonly label: string
}

/** One repository at one ref (default: the clone's HEAD, i.e. its fix branch). */
export const resolveTarget = async (
  repos: ReposToolContext,
  name: string,
  ref: string | undefined,
): Promise<Result<RepoTarget, string>> => {
  const repository = findRepository(repos.repositories, name)
  if (!repository.ok) return repository
  const commit = await resolveCommit(repository.value.dir, ref ?? 'HEAD')
  if (!commit.ok) return commit
  return ok({
    repository: repository.value,
    commit: commit.value,
    label: `${ref ?? repository.value.config.branches.fix} (${commit.value.id.slice(0, 7)})`,
  })
}

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

export const REF_DESCRIPTION =
  'Branch, tag or commit to read (default: the clone, which follows the fix branch). Remote branches work by name, e.g. "develop".'
