import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'
import { ChangeIdSchema, type ChangeRequest, ChangeRequestSchema } from './change-request.schema.ts'

export const newChangeId = (): string => `cr-${randomBytes(4).toString('hex')}`

/** Change requests as owner-only JSON files in the project's local/changes folder. */
export class ChangeStore {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  async save(change: ChangeRequest): Promise<Result<void, string>> {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(this.#dir, `${change.id}.json`),
        `${JSON.stringify(change, null, 2)}\n`,
        {
          mode: 0o600,
        },
      )
      return ok(undefined)
    } catch (error) {
      return err(`Could not save change ${change.id}: ${String(error)}`)
    }
  }

  async load(id: string): Promise<Result<ChangeRequest, string>> {
    const valid = ChangeIdSchema.safeParse(id)
    if (!valid.success) return err(`Invalid change id "${id}": it looks like cr-1a2b3c4d.`)
    let text: string
    try {
      text = await readFile(join(this.#dir, `${valid.data}.json`), 'utf8')
    } catch {
      return err(`No change ${valid.data}. List them with \`ticketsmith changes list\`.`)
    }
    const parsed = ChangeRequestSchema.safeParse(JSON.parse(text))
    return parsed.success
      ? ok(parsed.data)
      : err(`Change ${valid.data} is unreadable: ${parsed.error.message}`)
  }

  /** Every readable change, newest first. */
  async list(): Promise<readonly ChangeRequest[]> {
    let files: string[]
    try {
      files = await readdir(this.#dir)
    } catch {
      return []
    }
    const changes: ChangeRequest[] = []
    for (const file of files.filter((name) => /^cr-[0-9a-f]{8}\.json$/.test(name))) {
      const loaded = await this.load(file.replace(/\.json$/, ''))
      if (loaded.ok) changes.push(loaded.value)
    }
    return changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}
