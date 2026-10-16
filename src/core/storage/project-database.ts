import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { err, ok, type Result } from '../kernel/index.ts'

export type StorageError = {
  readonly kind: 'storage'
  readonly path: string
  readonly message: string
}

export type StepStatus = 'pending' | 'done' | 'failed'

export type OnboardingStep = {
  readonly step: string
  readonly status: StepStatus
  readonly updatedAt: string
  readonly detail: string | null
}

export type CatalogEntry<T> = {
  readonly key: string
  readonly data: T
  readonly refreshedAt: string
}

// Append-only: never edit a released migration, add a new one.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE onboarding_steps (
     step TEXT PRIMARY KEY,
     status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
     updated_at TEXT NOT NULL,
     detail TEXT
   );
   CREATE TABLE catalog (
     integration TEXT NOT NULL,
     kind TEXT NOT NULL,
     key TEXT NOT NULL,
     data TEXT NOT NULL,
     refreshed_at TEXT NOT NULL,
     PRIMARY KEY (integration, kind, key)
   );`,
]

const StepRowSchema = z.object({
  step: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  updated_at: z.string(),
  detail: z.string().nullable(),
})

const CatalogRowSchema = z.object({ key: z.string(), data: z.string(), refreshed_at: z.string() })

/**
 * The project's machine-local store (local/project.sqlite, Node's built-in SQLite): onboarding
 * progress and the catalog of investigated facts. It is a cache: everything in it can be rebuilt
 * with `project refresh`, so it is never shared.
 */
export class ProjectDatabase implements Disposable {
  readonly #db: DatabaseSync
  readonly #now: () => Date

  private constructor(db: DatabaseSync, now: () => Date) {
    this.#db = db
    this.#now = now
  }

  static open(
    path: string,
    now: () => Date = () => new Date(),
  ): Result<ProjectDatabase, StorageError> {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const db = new DatabaseSync(path)
      migrate(db)
      return ok(new ProjectDatabase(db, now))
    } catch (error) {
      return err({ kind: 'storage', path, message: String(error) })
    }
  }

  steps(): readonly OnboardingStep[] {
    return this.#db
      .prepare('SELECT step, status, updated_at, detail FROM onboarding_steps ORDER BY step')
      .all()
      .map((row) => {
        const parsed = StepRowSchema.parse(row)
        return {
          step: parsed.step,
          status: parsed.status,
          updatedAt: parsed.updated_at,
          detail: parsed.detail,
        }
      })
  }

  step(name: string): OnboardingStep | null {
    return this.steps().find((step) => step.step === name) ?? null
  }

  setStep(step: string, status: StepStatus, detail: string | null = null): void {
    this.#db
      .prepare(
        `INSERT INTO onboarding_steps (step, status, updated_at, detail) VALUES (?, ?, ?, ?)
         ON CONFLICT (step) DO UPDATE SET status = excluded.status,
           updated_at = excluded.updated_at, detail = excluded.detail`,
      )
      .run(step, status, this.#now().toISOString(), detail)
  }

  removeSteps(prefix: string): void {
    this.#db
      .prepare('DELETE FROM onboarding_steps WHERE step = ? OR step LIKE ?')
      .run(prefix, `${prefix}:%`)
  }

  /** Replaces every entry of one kind atomically, so a refresh never leaves a mix of old and new. */
  replaceCatalog(
    integration: string,
    kind: string,
    entries: readonly { readonly key: string; readonly data: unknown }[],
  ): void {
    const refreshedAt = this.#now().toISOString()
    const insert = this.#db.prepare(
      'INSERT INTO catalog (integration, kind, key, data, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    )
    this.#transaction(() => {
      this.#db
        .prepare('DELETE FROM catalog WHERE integration = ? AND kind = ?')
        .run(integration, kind)
      for (const entry of entries) {
        insert.run(integration, kind, entry.key, JSON.stringify(entry.data), refreshedAt)
      }
    })
  }

  clearCatalog(integration: string): void {
    this.#db.prepare('DELETE FROM catalog WHERE integration = ?').run(integration)
  }

  /** Reads one kind of catalog entries, validating each against `schema`. */
  catalog<T>(
    integration: string,
    kind: string,
    schema: z.ZodType<T>,
  ): Result<readonly CatalogEntry<T>[], StorageError> {
    const rows = this.#db
      .prepare(
        'SELECT key, data, refreshed_at FROM catalog WHERE integration = ? AND kind = ? ORDER BY key',
      )
      .all(integration, kind)
    const entries: CatalogEntry<T>[] = []
    for (const row of rows) {
      const { key, data, refreshed_at } = CatalogRowSchema.parse(row)
      const parsed = schema.safeParse(JSON.parse(data))
      if (!parsed.success) {
        return err({
          kind: 'storage',
          path: `catalog ${integration}/${kind}/${key}`,
          message: z.prettifyError(parsed.error),
        })
      }
      entries.push({ key, data: parsed.data, refreshedAt: refreshed_at })
    }
    return ok(entries)
  }

  [Symbol.dispose](): void {
    this.#db.close()
  }

  #transaction(work: () => void): void {
    this.#db.exec('BEGIN')
    try {
      work()
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}

const migrate = (db: DatabaseSync): void => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => z.object({ version: z.number() }).parse(row).version),
  )
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1
    if (applied.has(version)) return
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

/**
 * Opens the store, runs `work` and always closes it. Prefer this to `using` in src/: the
 * dependency-cruiser parser cannot read `using` declarations yet.
 */
export const withProjectDatabase = async <T>(
  path: string,
  work: (db: ProjectDatabase) => T | Promise<T>,
): Promise<Result<T, StorageError>> => {
  const db = ProjectDatabase.open(path)
  if (!db.ok) return db
  try {
    return ok(await work(db.value))
  } finally {
    db.value[Symbol.dispose]()
  }
}
