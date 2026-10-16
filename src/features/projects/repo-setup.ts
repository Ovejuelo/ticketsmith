import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { askConfirm, askText, fail, log, note, orFail, spinner } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import {
  BranchNameSchema,
  describeProjectError,
  type Project,
  type ProjectPaths,
  ProjectSchema,
  type RepositoryConfig,
  RepositoryConfigSchema,
  RepositoryNameSchema,
  RepositoryUrlSchema,
} from '../../core/project/index.ts'
import {
  cloneDir,
  listFiles,
  readFile,
  remoteBranches,
  remoteDefaultBranch,
  resolveCommit,
  suggestRepositoryName,
  syncRepository,
} from '../../core/repos/index.ts'
import type { Services } from '../../core/services/index.ts'
import { validateWith } from './jira-prompts.ts'
import { detectRuntime, detectTestCommand, isManifest } from './repo-map.ts'

export type RepoFlags = {
  readonly url?: string
  readonly name?: string
  readonly fixBranch?: string
  readonly featureBranch?: string
  readonly protected?: string
  readonly node?: string
  readonly testCommand?: string
  readonly allowCodeChanges?: boolean
  readonly branchPattern?: string
  readonly prTarget?: string
}

type Remote = { readonly defaultBranch: string; readonly branches: readonly string[] }

/** Proves the URL is reachable with the user's git credentials and lists its branches. */
const inspectRemote = async (url: string): Promise<Result<Remote, string>> => {
  const branches = await remoteBranches(url)
  if (!branches.ok) return branches
  const defaultBranch = await remoteDefaultBranch(url)
  return ok({
    defaultBranch: defaultBranch.ok ? defaultBranch.value : (branches.value[0] ?? 'main'),
    branches: branches.value,
  })
}

type Detected = { readonly node: string | undefined; readonly testCommand: string | undefined }

/** Runtime and test command from the clone's manifests at the fix branch. */
const detect = async (dir: string, branch: string): Promise<Detected> => {
  const commit = await resolveCommit(dir, branch)
  if (!commit.ok) return { node: undefined, testCommand: undefined }
  const files = await listFiles(dir, commit.value.id)
  if (!files.ok) return { node: undefined, testCommand: undefined }
  const manifests: Record<string, string> = {}
  for (const file of files.value.filter(isManifest)) {
    const content = await readFile(dir, commit.value.id, file)
    if (content.ok && content.value.kind === 'text') manifests[file] = content.value.text
  }
  return {
    node: detectRuntime(manifests),
    testCommand: detectTestCommand(files.value, manifests),
  }
}

/** Adds the repository, or replaces the one with the same name, validating the whole project. */
export const withRepository = (
  project: Project,
  config: RepositoryConfig,
): Result<Project, string> => {
  const others = (project.integrations.repos ?? []).filter((r) => r.name !== config.name)
  const parsed = ProjectSchema.safeParse({
    ...project,
    integrations: { ...project.integrations, repos: [...others, config] },
  })
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

const parseConfig = (input: Record<string, unknown>): Result<RepositoryConfig, string> => {
  const parsed = RepositoryConfigSchema.safeParse({ type: 'git', ...input })
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

const missingBranches = (remote: Remote, branches: readonly string[]): string[] =>
  branches.filter((branch) => !remote.branches.includes(branch))

/** A re-added repository with a new URL starts from a fresh clone. */
const dropStaleClone = async (project: Project, paths: ProjectPaths, config: RepositoryConfig) => {
  const existing = project.integrations.repos?.find((repo) => repo.name === config.name)
  if (existing !== undefined && existing.url !== config.url) {
    await rm(cloneDir(paths, config.name), { recursive: true, force: true })
  }
}

/** Scripted: flags describe one repository; branches default to the remote's default branch. */
export const addRepositoryFromFlags = async (
  services: Services,
  project: Project,
  paths: ProjectPaths,
  flags: RepoFlags,
): Promise<Project> => {
  if (flags.url === undefined) fail('Pass --url with the clone URL (ssh or https).')
  const invalidUrl = validateWith(RepositoryUrlSchema)(flags.url)
  if (invalidUrl !== undefined) fail(`Invalid --url: ${invalidUrl}`)
  const url = flags.url.trim()
  const remote = orFail(await inspectRemote(url), (e) => `Cannot reach ${url}: ${e}`)
  const fix = flags.fixBranch ?? remote.defaultBranch
  const feature = flags.featureBranch ?? remote.defaultBranch
  const missing = missingBranches(remote, [fix, feature])
  if (missing.length > 0) fail(`Branch(es) not found on the remote: ${missing.join(', ')}.`)

  const draft = orFail(
    parseConfig({
      name: flags.name ?? suggestRepositoryName(url),
      url,
      branches: { fix, feature },
      protectedBranches: splitList(flags.protected),
    }),
    (issues) => `Invalid repository flags:\n${issues}`,
  )
  await dropStaleClone(project, paths, draft)
  const dir = cloneDir(paths, draft.name)
  orFail(await syncRepository({ config: draft, dir }), (e) => `Could not clone ${url}: ${e}`)
  const detected = await detect(dir, fix)
  const config = orFail(
    parseConfig({
      ...draft,
      runtime: { node: flags.node ?? detected.node },
      testCommand: flags.testCommand ?? detected.testCommand,
      allowCodeChanges: flags.allowCodeChanges ?? false,
      ...(flags.branchPattern === undefined ? {} : { branchPattern: flags.branchPattern }),
      ...(flags.prTarget === undefined ? {} : { prTarget: flags.prTarget }),
    }),
    String,
  )
  const updated = orFail(withRepository(project, config), String)
  orFail(await services.projects.save(updated), describeProjectError)
  return updated
}

const ACCESS_HELP =
  'Ticketsmith uses your own git access: an SSH key (ssh-add) or a credential helper for https. Check it with `git ls-remote <url>` in a terminal. VPN-only hosts need the VPN up.'

/**
 * Interactive: adds repositories one by one. Each one is cloned right away (that also proves
 * access), then its runtime and test command are detected and offered as defaults.
 */
export const configureReposInteractively = async (
  services: Services,
  project: Project,
  paths: ProjectPaths,
): Promise<{ readonly project: Project; readonly changed: boolean }> => {
  let current = project
  let changed = false
  const existing = current.integrations.repos ?? []
  if (existing.length > 0) {
    note(
      existing
        .map((r) => `${r.name}  ${r.url}  (fix: ${r.branches.fix}, feature: ${r.branches.feature})`)
        .join('\n'),
      'Configured repositories',
    )
  }

  let addAnother = existing.length === 0 || (await askConfirm('Add or update a repository?', false))
  while (addAnother) {
    const url = (
      await askText({
        message: 'Clone URL (ssh or https, e.g. git@bitbucket.org:acme/billing-backend.git)',
        validate: validateWith(RepositoryUrlSchema),
      })
    ).trim()
    const progress = spinner()
    progress.start(`Checking access to ${url}`)
    const remote = await inspectRemote(url)
    if (!remote.ok) {
      progress.stop('Could not reach the repository')
      log.error(remote.error)
      note(ACCESS_HELP, 'Git access')
      addAnother = await askConfirm('Try again?', true)
      continue
    }
    progress.stop(`${remote.value.branches.length} branches, default ${remote.value.defaultBranch}`)

    const name = await askText({
      message: 'Repository name in this project',
      initialValue: suggestRepositoryName(url),
      validate: validateWith(RepositoryNameSchema),
    })
    const validateBranch = (value: string): string | undefined =>
      validateWith(BranchNameSchema)(value) ??
      (remote.value.branches.includes(value.trim()) ? undefined : 'Not a branch of this repository')
    const fix = (
      await askText({
        message: 'Base branch for fixes (the clone follows it: usually production)',
        initialValue: remote.value.defaultBranch,
        validate: validateBranch,
      })
    ).trim()
    const feature = (
      await askText({
        message: 'Base branch for new features',
        initialValue: fix,
        validate: validateBranch,
      })
    ).trim()
    const protectedBranches = splitList(
      await askText({
        message: 'Protected branches, never pushed to (comma-separated)',
        initialValue: [...new Set([fix, feature])].join(', '),
      }),
    )

    const draft = parseConfig({ name, url, branches: { fix, feature }, protectedBranches })
    if (!draft.ok) {
      log.error(draft.error)
      continue
    }
    await dropStaleClone(current, paths, draft.value)
    const dir = cloneDir(paths, draft.value.name)
    progress.start(`Cloning ${name}`)
    const cloned = await syncRepository({ config: draft.value, dir })
    if (!cloned.ok) {
      progress.stop(`Could not clone ${name}`)
      log.error(cloned.error)
      addAnother = await askConfirm('Try again?', true)
      continue
    }
    progress.stop(`Cloned ${name} at ${cloned.value.id.slice(0, 7)}`)

    const detected = await detect(dir, fix)
    const node = await askText({
      message: 'Node version (empty if not a Node project)',
      initialValue: detected.node ?? '',
    })
    const testCommand = await askText({
      message: 'Test command (empty for none)',
      initialValue: detected.testCommand ?? '',
    })
    const allowCodeChanges = await askConfirm(
      'Let the agent change code here (ticketsmith code)? It works in a worktree per ticket and asks you before every push.',
      false,
    )
    const branchPattern = allowCodeChanges
      ? await askText({
          message: 'Branch name for a ticket ({key} and {slug} are replaced)',
          initialValue: 'fix/{key}-{slug}',
          validate: (value) => (value.includes('{key}') ? undefined : 'Include {key}'),
        })
      : undefined
    const config = parseConfig({
      ...draft.value,
      runtime: node.trim() === '' ? {} : { node: node.trim() },
      testCommand: testCommand.trim() === '' ? undefined : testCommand.trim(),
      allowCodeChanges,
      ...(branchPattern === undefined ? {} : { branchPattern: branchPattern.trim() }),
    })
    const updated = config.ok ? withRepository(current, config.value) : config
    if (!updated.ok) {
      log.error(updated.error)
      continue
    }
    orFail(await services.projects.save(updated.value), describeProjectError)
    current = updated.value
    changed = true
    addAnother = await askConfirm('Add another repository?', false)
  }
  return { project: current, changed }
}
