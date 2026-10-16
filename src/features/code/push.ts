import { existsSync } from 'node:fs'
import type { OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import {
  checkPushable,
  compareUrl,
  hostTypeOf,
  parseRemote,
  pushBranch,
} from '../../core/repos/index.ts'
import { describeSecretError, gitHostSecret } from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'
import type { RepoOutcome } from './code-run.schema.ts'
import { loadCodeRun, saveCodeRun } from './run-code-change.ts'

export type PushIo = {
  show(text: string): void
  /** Asks a yes/no question; resolves false unless the person agrees. */
  confirm(question: string): Promise<boolean>
  /** Asks for a host token once (stored in the keychain); null to skip and get a link instead. */
  askToken(hostname: string): Promise<string | null>
}

/**
 * Pushes each repository's ticket branch (only after the person agrees, never forced, never to a
 * protected or base branch) and opens the pull request through the host's API when there is a
 * provider and a token, or prints the host's link and the text to paste otherwise.
 */
export const pushAndOpen = async (
  services: Services,
  opened: OpenedProject,
  key: string,
  only: readonly string[] | undefined,
  io: PushIo,
): Promise<Result<readonly RepoOutcome[], string>> => {
  const loaded = await loadCodeRun(opened.paths.outDir, key)
  if (!loaded.ok) return loaded
  const run = loaded.value
  const updated: RepoOutcome[] = []
  for (const outcome of run.repos) {
    if (
      (only !== undefined && !only.includes(outcome.repo)) ||
      outcome.commit === null ||
      outcome.pullRequest !== null
    ) {
      updated.push(outcome)
      continue
    }
    const config = opened.project.integrations.repos?.find((repo) => repo.name === outcome.repo)
    if (config === undefined) return err(`Repository "${outcome.repo}" is no longer configured.`)
    const pushable = checkPushable(outcome.branch, config)
    if (!pushable.ok) return pushable
    if (!existsSync(outcome.dir))
      return err(`The worktree of ${outcome.repo} is gone (${outcome.dir}).`)

    const warning =
      outcome.tests !== null && !outcome.tests.passed ? ' Its tests did NOT pass.' : ''
    const agreed = await io.confirm(
      `Push ${outcome.branch} of ${outcome.repo} to origin and open a pull request into ${outcome.target}?${warning}`,
    )
    if (!agreed) {
      updated.push(outcome)
      continue
    }
    if (!outcome.pushed) {
      const pushed = await pushBranch(outcome.dir, outcome.branch)
      if (!pushed.ok) return err(`${outcome.repo}: push failed: ${pushed.error}`)
    }
    const pullRequest = await openPullRequest(
      services,
      opened,
      config,
      outcome,
      run.pullRequest,
      io,
    )
    updated.push({ ...outcome, pushed: true, pullRequest })
    await saveCodeRun(opened.paths.outDir, {
      ...run,
      repos: [...updated, ...run.repos.slice(updated.length)],
    })
  }
  const saved = await saveCodeRun(opened.paths.outDir, { ...run, repos: updated })
  return saved.ok ? ok(updated) : saved
}

const openPullRequest = async (
  services: Services,
  opened: OpenedProject,
  config: NonNullable<OpenedProject['project']['integrations']['repos']>[number],
  outcome: RepoOutcome,
  text: { readonly title: string; readonly body: string },
  io: PushIo,
): Promise<string | null> => {
  const type = hostTypeOf(config)
  const remote = parseRemote(config.url)
  const fallback = (reason: string): null => {
    const link = compareUrl(config, outcome.branch, outcome.target)
    io.show(
      [
        `${outcome.repo}: pushed ${outcome.branch}. ${reason}`,
        link === null
          ? 'Open the pull request on your git host.'
          : `Open the pull request: ${link}`,
        '',
        `Title: ${text.title}`,
        '',
        text.body,
        '',
      ].join('\n'),
    )
    return null
  }
  if (type === 'none' || remote === null)
    return fallback('This host has no pull request provider in Ticketsmith.')

  const secret = gitHostSecret(remote.hostname)
  const stored = await services.loadSecret(opened.project.name, secret)
  if (!stored.ok) return fallback(describeSecretError(stored.error))
  let token = stored.value?.value ?? null
  if (token === null) {
    token = await io.askToken(remote.hostname)
    if (token === null) return fallback('No API token for this host.')
    const saved = await services.saveSecret(opened.project.name, secret, token)
    if (!saved.ok) io.show(`Could not store the token: ${describeSecretError(saved.error)}`)
  }
  const created = await services.pullRequestHost(type, config.host?.apiUrl).create(
    {
      owner: remote.owner,
      repo: remote.repo,
      head: outcome.branch,
      base: outcome.target,
      title: text.title,
      body: text.body,
    },
    token,
  )
  if (!created.ok)
    return fallback(`The pull request could not be created (${created.error.message}).`)
  io.show(`${outcome.repo}: pull request ${created.value.url}`)
  return created.value.url
}
