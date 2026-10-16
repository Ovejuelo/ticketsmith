import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'
import type { Project, ProjectPaths, RepositoryConfig } from '../project/index.ts'

/** A configured repository and the folder of its dedicated clone. */
export type Repository = {
  readonly config: RepositoryConfig
  readonly dir: string
}

export const cloneDir = (paths: ProjectPaths, name: string): string => join(paths.reposDir, name)

export const isCloned = (dir: string): boolean => existsSync(join(dir, '.git'))

export const projectRepositories = (project: Project, paths: ProjectPaths): readonly Repository[] =>
  (project.integrations.repos ?? []).map((config) => ({
    config,
    dir: cloneDir(paths, config.name),
  }))

/** Finds a repository by name and checks that its clone exists. */
export const findRepository = (
  repositories: readonly Repository[],
  name: string,
): Result<Repository, string> => {
  const repository = repositories.find((candidate) => candidate.config.name === name)
  if (repository === undefined) {
    const known = repositories.map((candidate) => candidate.config.name).join(', ') || 'none'
    return err(`Unknown repository "${name}". Known: ${known}.`)
  }
  return isCloned(repository.dir)
    ? ok(repository)
    : err(`Repository "${name}" is not cloned yet. Run \`ticketsmith project refresh repos\`.`)
}

/** `billing-backend` from `git@host:org/billing-backend.git` or `https://host/org/Billing_Backend`. */
export const suggestRepositoryName = (url: string): string =>
  (url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '')
    .replace(/\.git$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 64)
