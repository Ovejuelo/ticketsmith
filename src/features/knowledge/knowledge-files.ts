import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { err, ok, type Result } from '../../core/kernel/index.ts'

/** Resolves a knowledge file, refusing anything outside the folder (also through symlinks). */
export const resolveKnowledgeFile = async (
  dir: string,
  path: string,
): Promise<Result<string, string>> => {
  const normalized = path.trim().replace(/^\.\/+/, '')
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.split(/[\\/]/).includes('..') ||
    !normalized.endsWith('.md')
  ) {
    return err(
      `Invalid knowledge path "${path}": use a .md path relative to knowledge/, e.g. brief.md`,
    )
  }
  let root: string
  try {
    root = await realpath(dir)
  } catch {
    return err('This project has no knowledge yet: run `ticketsmith project refresh`.')
  }
  try {
    const file = await realpath(join(root, normalized))
    return file.startsWith(`${root}${sep}`)
      ? ok(file)
      : err(`"${path}" is outside the knowledge folder`)
  } catch {
    return err(
      `No knowledge file "${normalized}". Search with knowledge_search or start from brief.md.`,
    )
  }
}

export const readKnowledge = async (dir: string, path: string): Promise<Result<string, string>> => {
  const file = await resolveKnowledgeFile(dir, path)
  if (!file.ok) return file
  return ok(await readFile(file.value, 'utf8'))
}

/** Every .md file of the knowledge folder that really lives inside it, relative paths, sorted. */
export const listKnowledge = async (dir: string): Promise<readonly string[]> => {
  let root: string
  try {
    root = await realpath(dir)
  } catch {
    return []
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = relative(root, join(entry.parentPath, entry.name))
    const resolved = await resolveKnowledgeFile(root, path)
    if (resolved.ok) files.push(path.split(sep).join('/'))
  }
  return files.sort()
}

/**
 * Where a new or updated knowledge file goes: `<folder>/<name>.md` under the real knowledge folder.
 * Refuses a folder or file that resolves (through symlinks) outside it. Returns the file's current
 * content when it already exists, so callers can append instead of overwriting.
 */
export const resolveWritableKnowledgeFile = async (
  dir: string,
  folder: string,
  name: string,
): Promise<Result<{ readonly root: string; readonly existing: string | null }, string>> => {
  const outside = err(`knowledge/${folder}/${name} is outside the knowledge folder`)
  let root: string
  try {
    await mkdir(join(dir, folder), { recursive: true })
    root = await realpath(dir)
  } catch (error) {
    return err(`Cannot prepare knowledge/${folder}: ${String(error)}`)
  }
  const target = await realpath(join(root, folder))
  if (target !== join(root, folder)) return outside
  const file = join(target, name)
  try {
    const entry = await lstat(file)
    if (!entry.isFile()) return outside
    return ok({ root, existing: await readFile(file, 'utf8') })
  } catch {
    return ok({ root, existing: null })
  }
}
