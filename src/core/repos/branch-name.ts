import { err, ok, type Result } from '../kernel/index.ts'
import type { RepositoryConfig } from '../project/index.ts'
import { validateRef } from './git.ts'

/** "No se puede pagar con tarjeta" → "no-se-puede-pagar-con-tarjeta" (ASCII, at most 40 characters). */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')

/** The ticket's branch from the repository's pattern; never chosen by the agent. */
export const branchFor = (
  pattern: string,
  key: string,
  summary: string,
): Result<string, string> => {
  const name = pattern.replaceAll('{key}', key).replaceAll('{slug}', slugify(summary) || 'change')
  const valid = validateRef(name)
  if (
    !valid.ok ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.includes('{')
  ) {
    return err(`The branch pattern "${pattern}" gives an invalid branch name "${name}".`)
  }
  return ok(name)
}

/** Pushing is never allowed to protected branches, the base branches or the PR target. */
export const checkPushable = (branch: string, config: RepositoryConfig): Result<string, string> => {
  const forbidden = new Set([
    ...config.protectedBranches,
    config.branches.fix,
    config.branches.feature,
    config.prTarget ?? config.branches.fix,
  ])
  return forbidden.has(branch)
    ? err(`Refusing to push to "${branch}": it is a protected or base branch of ${config.name}.`)
    : ok(branch)
}
