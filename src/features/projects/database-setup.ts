import { z } from 'zod'
import {
  askChoice,
  askConfirm,
  askSecret,
  askText,
  fail,
  type Io,
  log,
  note,
  orFail,
  spinner,
} from '../../core/cli/index.ts'
import { DIALECT_LABEL, type Dialect, describeDatabaseError } from '../../core/database/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import {
  type DatabaseConfig,
  DatabaseConfigSchema,
  DatabaseNameSchema,
  describeProjectError,
  type Project,
  ProjectSchema,
} from '../../core/project/index.ts'
import { databaseSecret, describeSecretError, secretEnvVariable } from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'
import { validateWith } from './jira-prompts.ts'

export type DatabaseFlags = {
  readonly engine?: Dialect
  readonly name?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly user?: string
  /** PostgreSQL only: the schema to investigate and search (default public). */
  readonly schema?: string
  readonly group?: string
  readonly ssl?: boolean
  readonly allowChanges?: boolean
}

export type DatabaseCheck = { readonly canWrite: boolean }

/** Connects with the given credentials, pings and checks write privileges; always disconnects. */
export const verifyDatabase = async (
  services: Services,
  config: DatabaseConfig,
  password: string,
): Promise<Result<DatabaseCheck, string>> => {
  const adapter = services.connectDatabase(config, password)
  try {
    const ping = await adapter.ping()
    if (!ping.ok) return err(describeDatabaseError(ping.error))
    const canWrite = await adapter.accountCanWrite()
    return ok({ canWrite: canWrite.ok ? canWrite.value : false })
  } finally {
    await adapter[Symbol.asyncDispose]()
  }
}

/** Adds the database, or replaces the one with the same name, validating names and groups. */
export const withDatabase = (project: Project, config: DatabaseConfig): Result<Project, string> => {
  const others = (project.integrations.databases ?? []).filter((d) => d.name !== config.name)
  const parsed = ProjectSchema.safeParse({
    ...project,
    integrations: { ...project.integrations, databases: [...others, config] },
  })
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

export const DEFAULT_PORT: Readonly<Record<Dialect, number>> = { mysql: 3306, postgres: 5432 }

const parseConfig = (flags: DatabaseFlags): Result<DatabaseConfig, string> => {
  const engine = flags.engine ?? 'mysql'
  const parsed = DatabaseConfigSchema.safeParse({
    type: engine,
    name: flags.name,
    host: flags.host,
    port: flags.port ?? DEFAULT_PORT[engine],
    database: flags.database,
    user: flags.user,
    ...(engine === 'postgres' ? { schema: flags.schema || undefined } : {}),
    group: flags.group || undefined,
    ssl: flags.ssl ?? false,
    allowChanges: flags.allowChanges ?? false,
  })
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

const writeWarning = (name: string) =>
  `The account for "${name}" can write. Ticketsmith only runs guarded reads inside READ ONLY transactions; a read-only account is still safer.`

/** Scripted: flags describe one database; its password comes from TICKETSMITH_DB_<NAME>. */
export const addDatabaseFromFlags = async (
  services: Services,
  io: Io,
  project: Project,
  flags: DatabaseFlags,
): Promise<Project> => {
  const config = orFail(parseConfig(flags), (issues) => `Invalid database flags:\n${issues}`)
  const secret = databaseSecret(config.name)
  const password = orFail(await services.loadSecret(project.name, secret), describeSecretError)
  if (password === null)
    fail(`Set ${secretEnvVariable(secret)} with the password of "${config.name}".`)

  const check = orFail(await verifyDatabase(services, config, password.value), String)
  if (check.canWrite) io.err(`! ${writeWarning(config.name)}\n`)
  const updated = orFail(withDatabase(project, config), String)
  if (password.source !== 'environment') {
    orFail(await services.saveSecret(project.name, secret, password.value), describeSecretError)
  }
  orFail(await services.projects.save(updated), describeProjectError)
  return updated
}

/**
 * Interactive: adds databases one by one. Each new one starts from the previous one's port,
 * database, user and group, so adding several databases that share a schema (e.g. shards) only
 * needs a name, a host and a password each.
 */
export const configureDatabasesInteractively = async (
  services: Services,
  project: Project,
): Promise<{ readonly project: Project; readonly changed: boolean }> => {
  let current = project
  let changed = false
  const existing = current.integrations.databases ?? []
  if (existing.length > 0) {
    note(
      existing
        .map(
          (d) =>
            `${d.name}  ${DIALECT_LABEL[d.type]}  ${d.user}@${d.host}:${d.port}/${d.database}${d.group ? `  [${d.group}]` : ''}`,
        )
        .join('\n'),
      'Configured databases',
    )
  }

  let template: DatabaseConfig | undefined = existing.at(-1)
  let addAnother = existing.length === 0 || (await askConfirm('Add or update a database?', false))
  while (addAnother) {
    const name = await askText({
      message: 'Database name in this project (e.g. shard1, billing)',
      validate: validateWith(DatabaseNameSchema),
    })
    const engine = await askChoice<Dialect>(
      'Engine',
      [
        { value: 'mysql', label: 'MySQL' },
        { value: 'postgres', label: 'PostgreSQL' },
      ],
      template?.type ?? 'mysql',
    )
    const host = await askText({
      message: 'Host',
      initialValue: template?.host ?? '',
      validate: (v) => (v.trim() ? undefined : 'Required'),
    })
    const port = await askText({
      message: 'Port',
      initialValue: String(template?.type === engine ? template.port : DEFAULT_PORT[engine]),
      validate: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'A number'),
    })
    const database = await askText({
      message: 'Database (schema) name',
      initialValue: template?.database ?? '',
      validate: (v) => (v.trim() ? undefined : 'Required'),
    })
    const user = await askText({
      message: 'User',
      initialValue: template?.user ?? '',
      validate: (v) => (v.trim() ? undefined : 'Required'),
    })
    const schema =
      engine === 'postgres'
        ? await askText({
            message: 'Schema to investigate',
            initialValue: template?.type === 'postgres' ? template.schema : 'public',
            validate: (v) => (v.trim() ? undefined : 'Required'),
          })
        : undefined
    const group = await askText({
      message: 'Group (databases sharing one schema; empty for none)',
      initialValue: template?.group ?? '',
      validate: (v) => (v.trim() === '' ? undefined : validateWith(DatabaseNameSchema)(v)),
    })
    const password = await askSecret(`Password for ${user}@${host} (stored in the system keychain)`)
    const allowChanges = await askConfirm(
      'Let the agent propose changes (INSERT/UPDATE) here? You still approve each one in the terminal.',
      template?.allowChanges ?? false,
    )

    const config = parseConfig({
      engine,
      ...(schema === undefined ? {} : { schema }),
      name,
      host,
      port: Number(port),
      database,
      user,
      group,
      ssl: template?.ssl ?? false,
      allowChanges,
    })
    if (!config.ok) {
      log.error(config.error)
      continue
    }
    const progress = spinner()
    progress.start(`Connecting to ${name}`)
    const check = await verifyDatabase(services, config.value, password)
    if (!check.ok) {
      progress.stop(`Could not connect to ${name}`)
      log.error(check.error)
      addAnother = await askConfirm('Try again?', true)
      continue
    }
    progress.stop(`Connected to ${name}`)
    if (check.value.canWrite) log.warn(writeWarning(name))

    const updated = withDatabase(current, config.value)
    if (!updated.ok) {
      log.error(updated.error)
      continue
    }
    orFail(
      await services.saveSecret(current.name, databaseSecret(name), password),
      describeSecretError,
    )
    orFail(await services.projects.save(updated.value), describeProjectError)
    current = updated.value
    template = config.value
    changed = true
    addAnother = await askConfirm('Add another database?', config.value.group !== undefined)
  }
  return { project: current, changed }
}
