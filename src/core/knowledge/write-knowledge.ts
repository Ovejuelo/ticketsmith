import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'
import { type MaskingOptions, maskSensitiveData } from '../security/index.ts'

export type KnowledgeError = {
  readonly kind: 'knowledge'
  readonly path: string
  readonly message: string
}

export type WrittenKnowledge = {
  readonly path: string
  /** What was masked before writing, per detector. */
  readonly masked: Readonly<Record<string, number>>
}

const safeRelativePath = (relativePath: string): string | null => {
  const normalized = normalize(relativePath)
  return isAbsolute(normalized) || normalized.startsWith(`..${sep}`) || normalized === '..'
    ? null
    : normalized
}

/**
 * Writes a Markdown file into the project's knowledge folder. Knowledge is shared (it goes to the
 * project's git repo), so the content is always masked with the project's rules first.
 */
export const writeKnowledge = async (
  knowledgeDir: string,
  relativePath: string,
  markdown: string,
  masking: MaskingOptions,
): Promise<Result<WrittenKnowledge, KnowledgeError>> => {
  const safe = safeRelativePath(relativePath)
  if (safe === null || !safe.endsWith('.md')) {
    return err({ kind: 'knowledge', path: relativePath, message: 'Expected a relative .md path' })
  }
  const path = join(knowledgeDir, safe)
  const masked = maskSensitiveData(markdown, masking)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, masked.text.endsWith('\n') ? masked.text : `${masked.text}\n`)
    await rename(tmp, path)
    return ok({ path, masked: masked.counts })
  } catch (error) {
    return err({ kind: 'knowledge', path, message: String(error) })
  }
}

/** Removes a knowledge subfolder (e.g. when an integration is removed from the project). */
export const removeKnowledge = async (
  knowledgeDir: string,
  relativeDir: string,
): Promise<Result<void, KnowledgeError>> => {
  const safe = safeRelativePath(relativeDir)
  if (safe === null || safe === '.') {
    return err({ kind: 'knowledge', path: relativeDir, message: 'Expected a relative subfolder' })
  }
  try {
    await rm(join(knowledgeDir, safe), { recursive: true, force: true })
    return ok(undefined)
  } catch (error) {
    return err({ kind: 'knowledge', path: relativeDir, message: String(error) })
  }
}
