import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURES = new URL('../fixtures/repos/', import.meta.url).pathname

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } })

export type SeedFile = string | Buffer | { readonly symlink: string }

/**
 * A real git repository acting as a remote, in its own temp folder. Seed it from a fixture in
 * tests/fixtures/repos/ and/or explicit files; `commit` adds more history later.
 */
export class TestRemote implements Disposable {
  readonly root = mkdtempSync(join(tmpdir(), 'ticketsmith-remote-'))
  readonly dir = join(this.root, 'origin')
  readonly url: string

  constructor(
    options: { fixture?: string; files?: Record<string, SeedFile>; branch?: string } = {},
  ) {
    mkdirSync(this.dir)
    runGit(this.dir, 'init', '--quiet', '--initial-branch', options.branch ?? 'main')
    if (options.fixture !== undefined)
      cpSync(join(FIXTURES, options.fixture), this.dir, { recursive: true })
    this.#write(options.files ?? {})
    runGit(this.dir, 'add', '--all')
    runGit(this.dir, 'commit', '--quiet', '--allow-empty', '-m', 'initial')
    this.url = pathToFileURL(this.dir).href
  }

  commit(files: Record<string, SeedFile>, message = 'change'): string {
    this.#write(files)
    runGit(this.dir, 'add', '--all')
    runGit(this.dir, 'commit', '--quiet', '-m', message)
    return runGit(this.dir, 'rev-parse', 'HEAD').trim()
  }

  branch(name: string): void {
    runGit(this.dir, 'branch', name)
  }

  #write(files: Record<string, SeedFile>): void {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.dir, path)
      mkdirSync(dirname(target), { recursive: true })
      if (typeof content === 'object' && 'symlink' in content) symlinkSync(content.symlink, target)
      else writeFileSync(target, content)
    }
  }

  [Symbol.dispose](): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}
