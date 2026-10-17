import type { DatabaseAdapter } from '../database/index.ts'
import { err, ok, type Result } from '../kernel/index.ts'
import {
  type DatabaseConfig,
  type DatabaseTarget,
  databaseTargets,
  type Project,
} from '../project/index.ts'
import { databaseSecret, describeSecretError, secretEnvVariable } from '../secrets/index.ts'
import type { Services } from './services.ts'

/**
 * The project's databases, connected lazily: a password is read from the keychain only when that
 * database is first used, and every opened adapter is closed on dispose. Credentials never leave
 * this object.
 */
export class DatabaseConnections implements AsyncDisposable {
  readonly #services: Services
  readonly #project: string
  readonly #configs: readonly DatabaseConfig[]
  // Promises, not adapters: two calls racing for the same database must share one pool.
  readonly #open = new Map<string, Promise<Result<DatabaseAdapter, string>>>()

  constructor(services: Services, project: Project) {
    this.#services = services
    this.#project = project.name
    this.#configs = project.integrations.databases ?? []
  }

  get configs(): readonly DatabaseConfig[] {
    return this.#configs
  }

  get targets(): readonly DatabaseTarget[] {
    return databaseTargets(this.#configs)
  }

  /** Members of a group, or the single database with that name. */
  resolveTarget(name: string): Result<readonly DatabaseConfig[], string> {
    const members = this.targets.find((target) => target.name === name)?.members
    if (members !== undefined) return ok(members)
    const database = this.#configs.find((config) => config.name === name)
    return database !== undefined ? ok([database]) : err(this.#unknown(name))
  }

  connect(name: string): Promise<Result<DatabaseAdapter, string>> {
    const cached = this.#open.get(name)
    if (cached !== undefined) return cached
    const opening = this.#openAdapter(name)
    this.#open.set(name, opening)
    // A failure (e.g. no password yet) is not cached, so a later call can try again.
    void opening.then((result) => {
      if (!result.ok && this.#open.get(name) === opening) this.#open.delete(name)
    })
    return opening
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const opening = [...this.#open.values()]
    this.#open.clear()
    const results = await Promise.allSettled(opening)
    await Promise.allSettled(
      results.flatMap((settled) =>
        settled.status === 'fulfilled' && settled.value.ok
          ? [settled.value.value[Symbol.asyncDispose]()]
          : [],
      ),
    )
  }

  async #openAdapter(name: string): Promise<Result<DatabaseAdapter, string>> {
    const config = this.#configs.find((candidate) => candidate.name === name)
    if (config === undefined) return err(this.#unknown(name))

    const secret = await this.#services.loadSecret(this.#project, databaseSecret(name))
    if (!secret.ok) return err(describeSecretError(secret.error))
    if (secret.value === null) {
      return err(
        `No password stored for database "${name}". Run \`ticketsmith project add databases\` or set ${secretEnvVariable(databaseSecret(name))}.`,
      )
    }
    return ok(this.#services.connectDatabase(config, secret.value.value))
  }

  #unknown(name: string): string {
    const known = this.targets.map((target) =>
      target.members.length > 1 || target.members[0]?.group !== undefined
        ? `${target.name} (group: ${target.members.map((member) => member.name).join(', ')})`
        : target.name,
    )
    return `Unknown database or group "${name}". Known: ${known.join('; ') || 'none'}.`
  }
}
