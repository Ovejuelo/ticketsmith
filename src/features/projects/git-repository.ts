import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { err, ok, type Result } from '../../core/kernel/index.ts'

const run = promisify(execFile)

export const isGitRepository = (dir: string): boolean => existsSync(join(dir, '.git'))

/** Makes the project folder a git repository so it can later be pushed to its own remote. */
export const initGitRepository = async (dir: string): Promise<Result<void, string>> => {
  try {
    await run('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: dir })
    return ok(undefined)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}
