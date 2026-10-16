import { execFile } from 'node:child_process'
import { err, ok, type Result } from '../kernel/index.ts'

const LOCAL_TIMEOUT_MS = 30_000
const REMOTE_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 15 * 60_000
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024

type GitOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Exit codes that are not failures, e.g. 1 for `git grep` without matches. */
  readonly okCodes?: readonly number[]
}

type GitOutput = { readonly stdout: Buffer; readonly code: number }

/**
 * Runs git without a shell. Prompts are disabled so a missing credential fails fast instead of
 * hanging (the MCP server has no terminal); git uses the user's SSH agent or credential helper.
 */
const git = (
  args: readonly string[],
  options: GitOptions = {},
): Promise<Result<GitOutput, string>> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'buffer',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve(ok({ stdout, code: 0 }))
        const code = typeof error.code === 'number' ? error.code : -1
        if (options.okCodes?.includes(code)) return resolve(ok({ stdout, code }))
        if (error.killed) return resolve(err('git timed out'))
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve(err('The output is too large: narrow the path or the pattern'))
        }
        if (error.code === 'ENOENT') return resolve(err('git is not installed or not on the PATH'))
        resolve(err(describeGitFailure(stderr.toString('utf8'))))
      },
    )
  })

const text = (output: GitOutput): string => output.stdout.toString('utf8')

/** Turns git's stderr into a short message with the likely fix for remote access problems. */
export const describeGitFailure = (stderr: string): string => {
  const message =
    stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('hint:'))
      .join(' ')
      .replace(/^(fatal|error): /, '') || 'git failed'
  if (
    /could not resolve host|connection (timed out|refused)|network is unreachable/i.test(message)
  ) {
    return `${message} (is the VPN up?)`
  }
  if (
    /permission denied|authentication failed|terminal prompts disabled|could not read (username|password)|host key verification failed/i.test(
      message,
    )
  ) {
    return `${message} (check your SSH key or git credential helper; try \`git ls-remote <url>\` in a terminal)`
  }
  return message
}

// --- Input validation: everything below receives only values that passed these checks. ---

/** A revision as the agent may name it: a branch, a tag, `origin/x` or a commit id. */
export const validateRef = (ref: string): Result<string, string> =>
  /^[A-Za-z0-9._/-]{1,200}$/.test(ref) && !ref.startsWith('-') && !ref.includes('..')
    ? ok(ref)
    : err(`Invalid ref "${ref}": use a branch, tag or commit id`)

/** A path inside the repository, relative to its root; empty means the root. */
export const validateRepoPath = (path: string): Result<string, string> => {
  const normalized = path
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('-') ||
    normalized.startsWith(':') || // pathspec magic
    /[\0\\]/.test(normalized) ||
    segments.some((segment) => segment === '..')
  ) {
    return err(`Invalid path "${path}": use a path relative to the repository root`)
  }
  return ok(normalized === '.' ? '' : normalized)
}

// --- Remote operations ---

export const cloneRepository = async (url: string, dir: string): Promise<Result<void, string>> => {
  const result = await git(['clone', '--quiet', '--', url, dir], { timeoutMs: CLONE_TIMEOUT_MS })
  return result.ok ? ok(undefined) : result
}

/** The remote's default branch (what its HEAD points to). */
export const remoteDefaultBranch = async (url: string): Promise<Result<string, string>> => {
  const result = await git(['ls-remote', '--symref', '--', url, 'HEAD'], {
    timeoutMs: REMOTE_TIMEOUT_MS,
  })
  if (!result.ok) return result
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(text(result.value))
  return match?.[1] === undefined ? err('The remote has no default branch') : ok(match[1])
}

/** Branch names on the remote; also proves the URL is reachable with the user's credentials. */
export const remoteBranches = async (url: string): Promise<Result<readonly string[], string>> => {
  const result = await git(['ls-remote', '--heads', '--', url], { timeoutMs: REMOTE_TIMEOUT_MS })
  if (!result.ok) return result
  return ok(
    text(result.value)
      .split('\n')
      .flatMap((line) => {
        const match = /\trefs\/heads\/(.+)$/.exec(line)
        return match?.[1] === undefined ? [] : [match[1]]
      }),
  )
}

/** Fetches and moves the clone (detached) to the remote's `branch`, discarding nothing tracked. */
export const syncClone = async (dir: string, branch: string): Promise<Result<void, string>> => {
  const fetched = await git(['fetch', '--quiet', '--prune', 'origin'], {
    cwd: dir,
    timeoutMs: REMOTE_TIMEOUT_MS,
  })
  if (!fetched.ok) return fetched
  const checkout = await git(
    ['checkout', '--quiet', '--force', '--detach', `refs/remotes/origin/${branch}`],
    { cwd: dir },
  )
  return checkout.ok ? ok(undefined) : err(`Branch "${branch}": ${checkout.error}`)
}

// --- Local reads, all from git objects: only tracked content is ever visible ---

export type Commit = { readonly id: string; readonly date: string }

/** Resolves a validated ref to a commit, trying `origin/<ref>` for remote branches. */
export const resolveCommit = async (dir: string, ref: string): Promise<Result<Commit, string>> => {
  const valid = validateRef(ref)
  if (!valid.ok) return valid
  for (const candidate of [ref, `origin/${ref}`]) {
    const result = await git(
      ['log', '-1', '--format=%H%x00%cI', '--end-of-options', `${candidate}^{commit}`, '--'],
      { cwd: dir },
    )
    if (result.ok) {
      const [id = '', date = ''] = text(result.value).trim().split('\0')
      return ok({ id, date })
    }
  }
  return err(`Unknown ref "${ref}"`)
}

/** Tracked files of a commit, optionally under a directory. */
export const listFiles = async (
  dir: string,
  commit: string,
  path = '',
): Promise<Result<readonly string[], string>> => {
  const result = await git(
    ['ls-tree', '-r', '-z', '--name-only', commit, '--', ...(path === '' ? [] : [path])],
    { cwd: dir },
  )
  if (!result.ok) return result
  return ok(
    text(result.value)
      .split('\0')
      .filter((file) => file !== ''),
  )
}

export type GrepMatch = { readonly path: string; readonly line: number; readonly text: string }

export type GrepQuery = {
  readonly pattern: string
  /** Extended regular expression; otherwise the pattern is a fixed string. */
  readonly regex: boolean
  readonly ignoreCase: boolean
  readonly commit: string
  readonly path: string
}

export const grep = async (
  dir: string,
  query: GrepQuery,
): Promise<Result<readonly GrepMatch[], string>> => {
  const result = await git(
    [
      'grep',
      '-n',
      '-I',
      '--no-color',
      '--null',
      query.regex ? '-E' : '-F',
      ...(query.ignoreCase ? ['-i'] : []),
      '-e',
      query.pattern,
      query.commit,
      '--',
      ...(query.path === '' ? [] : [query.path]),
    ],
    { cwd: dir, okCodes: [1] },
  )
  if (!result.ok) return result
  // With --null each match is `<commit>:<path>\0<line>\0<text>`.
  const prefix = `${query.commit}:`
  return ok(
    text(result.value)
      .split('\n')
      .flatMap((entry) => {
        const [location = '', line = '', ...rest] = entry.split('\0')
        if (!location.startsWith(prefix) || !/^\d+$/.test(line)) return []
        return [{ path: location.slice(prefix.length), line: Number(line), text: rest.join('\0') }]
      }),
  )
}

export type FileContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly bytes: number }

/** A tracked file's content at `commit`; a symlink yields its target path, never what it points to. */
export const readFile = async (
  dir: string,
  commit: string,
  path: string,
): Promise<Result<FileContent, string>> => {
  const object = `${commit}:${path}`
  const type = await git(['cat-file', '-t', object], { cwd: dir })
  if (!type.ok) return err(`No tracked file "${path}" at this ref`)
  const kind = text(type.value).trim()
  if (kind === 'tree') return err(`"${path}" is a directory: list it with repo_files`)
  if (kind !== 'blob') return err(`"${path}" is not a file`)
  const blob = await git(['cat-file', 'blob', object], { cwd: dir })
  if (!blob.ok) return blob
  const bytes = blob.value.stdout
  return bytes.subarray(0, 8000).includes(0)
    ? ok({ kind: 'binary', bytes: bytes.length })
    : ok({ kind: 'text', text: bytes.toString('utf8') })
}

// --- Worktrees for code changes (phase 8): one per ticket and repository ---

/** Whether a local branch exists in the clone. */
export const branchExists = async (dir: string, branch: string): Promise<boolean> =>
  (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir })).ok

/** A new worktree at `path` on `branch`: created from `startRef`, or the existing branch reused. */
export const addWorktree = async (
  cloneDir: string,
  path: string,
  branch: string,
  startRef: string,
): Promise<Result<void, string>> => {
  const args = (await branchExists(cloneDir, branch))
    ? ['worktree', 'add', '--quiet', path, branch]
    : ['worktree', 'add', '--quiet', '-b', branch, path, startRef]
  const result = await git(args, { cwd: cloneDir })
  return result.ok ? ok(undefined) : result
}

export const removeWorktree = async (
  cloneDir: string,
  path: string,
  branch: string,
): Promise<Result<void, string>> => {
  const removed = await git(['worktree', 'remove', '--force', path], { cwd: cloneDir })
  if (!removed.ok && !/is not a working tree/.test(removed.error)) return removed
  await git(['worktree', 'prune'], { cwd: cloneDir })
  const deleted = await git(['branch', '-D', branch], { cwd: cloneDir, okCodes: [1] })
  return deleted.ok ? ok(undefined) : deleted
}

/** The commit where the worktree's branch left `baseRef`. */
export const mergeBase = async (dir: string, baseRef: string): Promise<Result<string, string>> => {
  const result = await git(['merge-base', 'HEAD', baseRef], { cwd: dir })
  return result.ok ? ok(text(result.value).trim()) : result
}

/** Uncommitted changes, new files included, as a patch against HEAD (new files marked intent-to-add). */
export const workingDiff = async (dir: string): Promise<Result<string, string>> => {
  const marked = await git(['add', '--all', '--intent-to-add'], { cwd: dir })
  if (!marked.ok) return marked
  const result = await git(['diff', '--no-color', 'HEAD'], { cwd: dir })
  return result.ok ? ok(text(result.value)) : result
}

/** Everything the branch changed since `base`, as a patch and as a --stat summary. */
export const branchDiff = async (
  dir: string,
  base: string,
): Promise<Result<{ readonly patch: string; readonly stat: string }, string>> => {
  const patch = await git(['diff', '--no-color', `${base}..HEAD`], { cwd: dir })
  if (!patch.ok) return patch
  const stat = await git(['diff', '--no-color', '--stat', `${base}..HEAD`], { cwd: dir })
  if (!stat.ok) return stat
  return ok({ patch: text(patch.value), stat: text(stat.value) })
}

/** Commits every change in the worktree with the user's git identity; null when nothing changed. */
export const commitAll = async (
  dir: string,
  message: string,
): Promise<Result<string | null, string>> => {
  const added = await git(['add', '--all'], { cwd: dir })
  if (!added.ok) return added
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: dir, okCodes: [1] })
  if (!staged.ok) return staged
  if (staged.value.code === 0) return ok(null)
  const committed = await git(['commit', '--quiet', '--no-verify', '-m', message], { cwd: dir })
  if (!committed.ok) {
    return err(
      /tell me who you are|user\.email/i.test(committed.error)
        ? 'git has no identity for commits: set `git config --global user.name` and `user.email`.'
        : committed.error,
    )
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir })
  return head.ok ? ok(text(head.value).trim()) : head
}

/** Pushes HEAD to `branch` on origin: an explicit refspec, never forced. */
export const pushBranch = async (dir: string, branch: string): Promise<Result<void, string>> => {
  const valid = validateRef(branch)
  if (!valid.ok) return valid
  const result = await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
    cwd: dir,
    timeoutMs: REMOTE_TIMEOUT_MS,
  })
  return result.ok ? ok(undefined) : result
}
