import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'

export type OutputError = {
  readonly kind: 'io'
  readonly path: string
  readonly message: string
}

/** Per-ticket output folder inside the project's local/out (never inside the Ticketsmith repo). */
export const ticketOutputDir = (outDir: string, ticketKey: string): string =>
  join(outDir, ticketKey)

/** Writes files owner-only because outputs contain company data. Returns the written paths. */
export const writeOutputFiles = async (
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<Result<readonly string[], OutputError>> => {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const written: string[] = []
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name)
      await writeFile(path, content, { mode: 0o600 })
      written.push(path)
    }
    return ok(written)
  } catch (error) {
    return err({ kind: 'io', path: dir, message: String(error) })
  }
}
