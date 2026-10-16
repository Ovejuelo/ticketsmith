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
  readonly #open = new Map<string, DatabaseAdapter>()

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

  async connect(name: string): Promise<Result<DatabaseAdapter, string>> {
    const cached = this.#open.get(name)
    if (cached !== undefined) return ok(cached)
    const config = this.#configs.find((candidate) => candidate.name === name)
    if (config === undefined) return err(this.#unknown(name))

    const secret = await this.#services.loadSecret(this.#project, databaseSecret(name))
    if (!secret.ok) return err(describeSecretError(secret.error))
    if (secret.value === null) {
      return err(
        `No password stored for database "${name}". Run \`ticketsmith project add databases\` or set ${secretEnvVariable(databaseSecret(name))}.`,
      )
    }
    const adapter = this.#services.connectDatabase(config, secret.value.value)
    this.#open.set(name, adapter)
    return ok(adapter)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const adapters = [...this.#open.values()]
    this.#open.clear()
    await Promise.allSettled(adapters.map((adapter) => adapter[Symbol.asyncDispose]()))
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
