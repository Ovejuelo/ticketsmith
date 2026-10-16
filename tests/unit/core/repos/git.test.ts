import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cloneRepository,
  describeGitFailure,
  grep,
  listFiles,
  readFile,
  remoteBranches,
  remoteDefaultBranch,
  resolveCommit,
  syncClone,
  validateRef,
  validateRepoPath,
} from '#src/core/repos/git.ts'
import { TestRemote } from '#tests/support/git-repos.ts'

describe('validateRef', () => {
  it.each(['main', 'origin/develop', 'hotfix/OPS-1-fix', 'v1.2.3', 'a1b2c3d'])(
    'accepts %s',
    (ref) => {
      expect(validateRef(ref).ok).toBe(true)
    },
  )

  it.each([
    '--output=/tmp/x',
    '-x',
    'main..develop',
    'HEAD~1;rm -rf /',
    'HEAD@{1}',
    'main:secret',
    '',
    'a b',
  ])('rejects %s', (ref) => {
    expect(validateRef(ref).ok).toBe(false)
  })
})

describe('validateRepoPath', () => {
  it('normalizes relative paths and the root', () => {
    expect(validateRepoPath('./src/routes/')).toEqual({ ok: true, value: 'src/routes' })
    expect(validateRepoPath('')).toEqual({ ok: true, value: '' })
    expect(validateRepoPath('.')).toEqual({ ok: true, value: '' })
  })

  it.each([
    '../../etc/passwd',
    'src/../../secret',
    '/etc/passwd',
    '-x',
    ':(top)secret',
    'a\\b',
    'nul\0byte',
  ])('rejects %s', (path) => {
    expect(validateRepoPath(path).ok).toBe(false)
  })
})

describe('describeGitFailure', () => {
  it('adds the likely fix for unreachable hosts and missing credentials', () => {
    expect(
      describeGitFailure('fatal: unable to access: Could not resolve host: git.acme.dev'),
    ).toMatch(/VPN/)
    expect(
      describeGitFailure(
        'git@bitbucket.org: Permission denied (publickey).\nfatal: Could not read',
      ),
    ).toMatch(/SSH key or git credential helper/)
    expect(
      describeGitFailure(
        "fatal: could not read Username for 'https://x': terminal prompts disabled",
      ),
    ).toMatch(/credential helper/)
  })
})

describe('git operations on a real repository', () => {
  let remote: TestRemote
  let work: string
  let clone: string

  beforeAll(async () => {
    remote = new TestRemote({
      fixture: 'api-express',
      files: {
        '.gitignore': '.env\n',
        '.env': 'DB_PASSWORD=hunter2\n',
        'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
        'docs/outside': { symlink: '/etc/hosts' },
        'big.txt': Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'),
      },
    })
    remote.branch('develop')
    work = mkdtempSync(join(tmpdir(), 'ticketsmith-clone-'))
    clone = join(work, 'api')
    const cloned = await cloneRepository(remote.url, clone)
    expect(cloned).toEqual({ ok: true, value: undefined })
  })

  afterAll(() => {
    remote[Symbol.dispose]()
    rmSync(work, { recursive: true, force: true })
  })

  it('reads the remote default branch and branches', async () => {
    expect(await remoteDefaultBranch(remote.url)).toEqual({ ok: true, value: 'main' })
    const branches = await remoteBranches(remote.url)
    expect(branches.ok && [...branches.value].sort()).toEqual(['develop', 'main'])
  })

  it('fails with a readable message for an unreachable remote', async () => {
    const result = await remoteBranches('file:///nonexistent/ticketsmith/repo')
    expect(result.ok).toBe(false)
  })

  it('lists only tracked files: ignored files never show up', async () => {
    const head = await resolveCommit(clone, 'main')
    if (!head.ok) throw new Error(head.error)
    const files = await listFiles(clone, head.value.id)
    expect(files.ok && files.value).toContain('src/routes/accounts.js')
    expect(files.ok && files.value).not.toContain('.env')

    const routes = await listFiles(clone, head.value.id, 'src/routes')
    expect(routes).toEqual({ ok: true, value: ['src/routes/accounts.js'] })
  })

  it('resolves branches, remote branches and commits; rejects unknown or invalid refs', async () => {
    const main = await resolveCommit(clone, 'main')
    const develop = await resolveCommit(clone, 'develop') // only exists as origin/develop
    expect(main.ok && develop.ok && main.value.id === develop.value.id).toBe(true)
    expect(main.ok && main.value.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((await resolveCommit(clone, 'nope')).ok).toBe(false)
    expect((await resolveCommit(clone, '--output=/tmp/x')).ok).toBe(false)
  })

  it('greps fixed strings and regexes with file and line, even patterns starting with "-"', async () => {
    const head = await resolveCommit(clone, 'main')
    if (!head.ok) throw new Error(head.error)
    const query = { regex: false, ignoreCase: false, commit: head.value.id, path: '' }

    const found = await grep(clone, { ...query, pattern: "router.get('/:id'" })
    expect(found).toEqual({
      ok: true,
      value: [
        {
          path: 'src/routes/accounts.js',
          line: 6,
          text: "router.get('/:id', async (req, res) => {",
        },
      ],
    })

    const regex = await grep(clone, { ...query, regex: true, pattern: 'router\\.(get|post)' })
    expect(regex.ok && regex.value.map((m) => m.line)).toEqual([6, 12])

    const dashed = await grep(clone, { ...query, pattern: '--output=/tmp/pwned' })
    expect(dashed).toEqual({ ok: true, value: [] })

    const scoped = await grep(clone, { ...query, pattern: 'express', path: 'src/models' })
    expect(scoped).toEqual({ ok: true, value: [] })

    const secret = await grep(clone, { ...query, pattern: 'hunter2' })
    expect(secret).toEqual({ ok: true, value: [] })
  })

  it('reads tracked text; symlinks yield their target path and binaries are flagged', async () => {
    const head = await resolveCommit(clone, 'main')
    if (!head.ok) throw new Error(head.error)
    const commit = head.value.id

    const file = await readFile(clone, commit, 'src/models/account.js')
    expect(file.ok && file.value.kind === 'text' && file.value.text).toMatch(/sequelize\.define/)

    expect(await readFile(clone, commit, 'docs/outside')).toEqual({
      ok: true,
      value: { kind: 'text', text: '/etc/hosts' },
    })
    expect(await readFile(clone, commit, 'assets/logo.png')).toEqual({
      ok: true,
      value: { kind: 'binary', bytes: 7 },
    })
    expect(await readFile(clone, commit, '.env')).toEqual({
      ok: false,
      error: 'No tracked file ".env" at this ref',
    })
    expect((await readFile(clone, commit, 'src')).ok).toBe(false)
  })

  it('syncs the clone to the latest commit of a branch', async () => {
    const before = await resolveCommit(clone, 'HEAD')
    const next = remote.commit({ 'CHANGELOG.md': '# Changes\n' })

    expect(await syncClone(clone, 'main')).toEqual({ ok: true, value: undefined })
    const after = await resolveCommit(clone, 'HEAD')
    expect(after.ok && after.value.id).toBe(next)
    expect(before.ok && after.ok && before.value.id !== after.value.id).toBe(true)
    expect(existsSync(join(clone, 'CHANGELOG.md'))).toBe(true)

    expect((await syncClone(clone, 'missing-branch')).ok).toBe(false)
  })
})
