import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import type { ProjectPaths } from '../../core/project/index.ts'

/** What travels with a project: everything at its root except local/ (and git metadata). */
const SHARED_ENTRIES = ['project.yaml', '.gitignore', 'knowledge'] as const

const isEmptyOrMissing = async (dir: string): Promise<boolean> => {
  try {
    return (await readdir(dir)).length === 0
  } catch {
    return true
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Copies the shareable part of a project into `from` → `to`; `to` must be empty or new. */
export const copySharedFiles = async (
  from: string,
  to: string,
): Promise<Result<readonly string[], string>> => {
  if (!(await isEmptyOrMissing(to))) return err(`${to} is not empty.`)
  if (!(await exists(join(from, 'project.yaml')))) return err(`${from} has no project.yaml.`)
  try {
    await mkdir(to, { recursive: true, mode: 0o700 })
    const copied: string[] = []
    for (const entry of SHARED_ENTRIES) {
      if (await exists(join(from, entry))) {
        await cp(join(from, entry), join(to, entry), { recursive: true })
        copied.push(entry)
      }
    }
    return ok(copied)
  } catch (error) {
    return err(String(error))
  }
}

export const exportProject = (location: ProjectPaths, destination: string) =>
  copySharedFiles(location.root, destination)
