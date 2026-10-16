import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ProjectPaths, projectPaths } from '#src/core/project/index.ts'
import {
  branchDiff,
  branchFor,
  checkPushable,
  commitAll,
  prepareWorktree,
  pushBranch,
  type Repository,
  removeWorktree,
  slugify,
  workingDiff,
} from '#src/core/repos/index.ts'
import { testRepository } from '#tests/support/fake-cli.ts'
import { runGit, TestRemote } from '#tests/support/git-repos.ts'

describe('branch names', () => {
  it('slugifies ticket summaries to ASCII', () => {
    expect(slugify('No se puede pagar con tarjeta: ¡error 500!')).toBe(
      'no-se-puede-pagar-con-tarjeta-error-500',
    )
    expect(slugify('A'.repeat(60))).toHaveLength(40)
    expect(slugify('¿¿??')).toBe('')
  })

  it('builds the branch from the pattern and rejects invalid results', () => {
    expect(branchFor('hotfix/{key}-{slug}', 'OPS-7', 'Pago rechazado')).toEqual({
      ok: true,
      value: 'hotfix/OPS-7-pago-rechazado',
    })
    expect(branchFor('fix/{key}', 'OPS-7', '')).toEqual({ ok: true, value: 'fix/OPS-7' })
    expect(branchFor('fix/{key}-{slug}', 'OPS-7', '???')).toEqual({
      ok: true,
      value: 'fix/OPS-7-change',
    })
    expect(branchFor('fix//{key}', 'OPS-7', 'x').ok).toBe(false)
    expect(branchFor('-{key}', 'OPS-7', 'x').ok).toBe(false)
  })

  it('never allows pushing to protected or base branches', () => {
    const config = testRepository('api', {
      branches: { fix: 'master', feature: 'develop' },
      protectedBranches: ['master', 'stage', 'develop'],
      prTarget: 'stage',
    })
    for (const branch of ['master', 'stage', 'develop'])
      expect(checkPushable(branch, config).ok).toBe(false)
    expect(checkPushable('hotfix/OPS-7-x', config)).toEqual({ ok: true, value: 'hotfix/OPS-7-x' })
  })
})

describe('ticket worktrees on real repositories', () => {
  let remote: TestRemote
  let root: string
  let paths: ProjectPaths
  let repository: Repository

  beforeEach(() => {
    remote = new TestRemote({ fixture: 'api-express', branch: 'master' })
    root = mkdtempSync(join(tmpdir(), 'ticketsmith-worktrees-'))
    paths = projectPaths(root)
    repository = {
      config: testRepository('api', {
        url: remote.url,
        branches: { fix: 'master', feature: 'master' },
        protectedBranches: ['master'],
        branchPattern: 'hotfix/{key}-{slug}',
      }),
      dir: join(paths.reposDir, 'api'),
    }
  })
  afterEach(() => {
    remote[Symbol.dispose]()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the branch from the fix branch, diffs new files, commits and pushes without force', async () => {
    const worktree = await prepareWorktree(paths, repository, 'OPS-7', 'Pago rechazado')
    if (!worktree.ok) throw new Error(worktree.error)
    expect(worktree.value.dir).toBe(join(root, 'local', 'worktrees', 'OPS-7', 'api'))
    expect(worktree.value.branch).toBe('hotfix/OPS-7-pago-rechazado')
    expect(worktree.value.base).toBe(runGit(remote.dir, 'rev-parse', 'master').trim())

    writeFileSync(
      join(worktree.value.dir, 'src', 'routes', 'accounts.js'),
      'module.exports = "fixed"\n',
    )
    writeFileSync(join(worktree.value.dir, 'src', 'new.js'), 'module.exports = 1\n')
    const working = await workingDiff(worktree.value.dir)
    expect(working.ok && working.value).toContain('+++ b/src/new.js')
    expect(working.ok && working.value).toContain('+module.exports = "fixed"')

    const commit = await commitAll(worktree.value.dir, 'fix(OPS-7): reject expired cards')
    expect(commit.ok && commit.value).toMatch(/^[0-9a-f]{40}$/)
    expect(await commitAll(worktree.value.dir, 'again')).toEqual({ ok: true, value: null })

    const diff = await branchDiff(worktree.value.dir, worktree.value.base)
    expect(diff.ok && diff.value.stat).toMatch(/2 files changed/)

    expect(await pushBranch(worktree.value.dir, worktree.value.branch)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(runGit(remote.dir, 'branch', '--list', 'hotfix/*').trim()).toBe(
      'hotfix/OPS-7-pago-rechazado',
    )

    // Somebody else moves the remote branch: a push that would overwrite it is refused, not forced.
    runGit(remote.dir, 'branch', '-f', 'hotfix/OPS-7-pago-rechazado', 'master')
    writeFileSync(join(worktree.value.dir, 'src', 'new.js'), 'module.exports = 2\n')
    await commitAll(worktree.value.dir, 'second')
    runGit(remote.dir, 'checkout', '--quiet', 'hotfix/OPS-7-pago-rechazado')
    writeFileSync(join(remote.dir, 'theirs.txt'), 'theirs\n')
    runGit(remote.dir, 'add', '--all')
    runGit(remote.dir, 'commit', '--quiet', '-m', 'theirs')
    runGit(remote.dir, 'checkout', '--quiet', 'master')
    expect((await pushBranch(worktree.value.dir, worktree.value.branch)).ok).toBe(false)
  })

  it('reuses the worktree on a second run and removes it with its branch', async () => {
    const first = await prepareWorktree(paths, repository, 'OPS-7', 'Pago rechazado')
    if (!first.ok) throw new Error(first.error)
    writeFileSync(join(first.value.dir, 'WIP.md'), 'in progress\n')

    const second = await prepareWorktree(paths, repository, 'OPS-7', 'Pago rechazado')
    expect(second.ok && second.value.dir).toBe(first.value.dir)
    expect(existsSync(join(first.value.dir, 'WIP.md'))).toBe(true)

    expect(await removeWorktree(repository.dir, first.value.dir, first.value.branch)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(existsSync(first.value.dir)).toBe(false)
    expect(runGit(repository.dir, 'branch', '--list', 'hotfix/*').trim()).toBe('')
  })
})
