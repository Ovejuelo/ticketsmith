import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditEntry, AuditLog } from './audit-log.port.ts'

export type JsonlAuditLogOptions = {
  /** The project's audit directory: <project>/local/audit */
  readonly dir: string
  readonly command: string
  readonly project: string
  readonly onError: (error: unknown) => void
  readonly now?: () => Date
  readonly pid?: number
}

/** Appends one JSON line per entry to audit/<date>-<command>-<pid>.jsonl (owner-only). */
export class JsonlAuditLog implements AuditLog {
  readonly #options: JsonlAuditLogOptions
  readonly #now: () => Date
  readonly #file: string

  constructor(options: JsonlAuditLogOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date())
    const date = this.#now().toISOString().slice(0, 10)
    this.#file = join(options.dir, `${date}-${options.command}-${options.pid ?? process.pid}.jsonl`)
  }

  get file(): string {
    return this.#file
  }

  async record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({
      ts: this.#now().toISOString(),
      command: this.#options.command,
      project: this.#options.project,
      ...entry,
    })
    try {
      await mkdir(this.#options.dir, { recursive: true, mode: 0o700 })
      await appendFile(this.#file, `${line}\n`, { mode: 0o600 })
    } catch (error) {
      this.#options.onError(error)
    }
  }
}
