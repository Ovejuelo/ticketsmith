import { z } from 'zod'
import {
  askChoice,
  askConfirm,
  askSecret,
  askText,
  fail,
  log,
  orFail,
  spinner,
} from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { describeMetabaseError, type MetabaseDatabase } from '../../core/metabase/index.ts'
import {
  describeProjectError,
  type MetabaseConfig,
  MetabaseConfigSchema,
  type Project,
  ProjectSchema,
} from '../../core/project/index.ts'
import {
  describeSecretError,
  METABASE_API_KEY,
  secretEnvVariable,
} from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'

export type MetabaseFlags = {
  readonly url?: string
  /** `shard1=3,billing=4`: project database = Metabase database id. */
  readonly map?: string
  readonly collection?: number
}

const parseMap = (map: string | undefined): Result<Record<string, number>, string> => {
  const entries: [string, number][] = []
  for (const pair of (map ?? '').split(',').filter((item) => item.trim() !== '')) {
    const [name, id] = pair.split('=').map((part) => part.trim())
    if (!name || !id || !/^\d+$/.test(id)) return err(`"${pair}" is not name=id`)
    entries.push([name, Number(id)])
  }
  return ok(Object.fromEntries(entries))
}

const withMetabase = (project: Project, config: MetabaseConfig): Result<Project, string> => {
  const unknown = Object.keys(config.databaseIds).filter(
    (name) => !(project.integrations.databases ?? []).some((database) => database.name === name),
  )
  if (unknown.length > 0) {
    return err(`Not databases of this project: ${unknown.join(', ')} (see \`project show\`).`)
  }
  const parsed = ProjectSchema.safeParse({
    ...project,
    integrations: { ...project.integrations, metabase: config },
  })
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

/** Connects with the key and lists Metabase's databases; the key is never stored before this works. */
const verify = async (
  services: Services,
  url: string,
  apiKey: string,
): Promise<Result<readonly MetabaseDatabase[], string>> => {
  const client = services.connectMetabase(url, apiKey)
  const user = await client.currentUser()
  if (!user.ok) return err(describeMetabaseError(user.error))
  const databases = await client.databases()
  return databases.ok ? databases : err(describeMetabaseError(databases.error))
}

/** Scripted: --url, optional --map and --collection; the API key comes from the environment. */
export const addMetabaseFromFlags = async (
  services: Services,
  project: Project,
  flags: MetabaseFlags,
): Promise<Project> => {
  if (!flags.url) fail('Metabase needs --url (and optionally --map name=id,… and --collection).')
  const key = orFail(await services.loadSecret(project.name, METABASE_API_KEY), describeSecretError)
  if (key === null) fail(`Set ${secretEnvVariable(METABASE_API_KEY)} with a Metabase API key.`)
  const databaseIds = orFail(parseMap(flags.map), (issue) => `Invalid --map: ${issue}`)
  const config = MetabaseConfigSchema.safeParse({
    type: 'metabase',
    url: flags.url.replace(/\/+$/, ''),
    databaseIds,
    collectionId: flags.collection,
  })
  if (!config.success) fail(`Invalid Metabase settings:\n${z.prettifyError(config.error)}`)
  const databases = orFail(await verify(services, config.data.url, key.value), String)
  const missing = Object.entries(databaseIds).filter(
    ([, id]) => !databases.some((database) => database.id === id),
  )
  if (missing.length > 0) {
    fail(`Metabase has no database with id ${missing.map(([, id]) => id).join(', ')}.`)
  }
  const updated = orFail(withMetabase(project, config.data), String)
  if (key.source !== 'environment') {
    orFail(
      await services.saveSecret(project.name, METABASE_API_KEY, key.value),
      describeSecretError,
    )
  }
  orFail(await services.projects.save(updated), describeProjectError)
  return updated
}

/** Interactive: URL and API key, then which Metabase database each project database is. */
export const configureMetabaseInteractively = async (
  services: Services,
  project: Project,
): Promise<Project> => {
  const current = project.integrations.metabase
  const url = (
    await askText({
      message: 'Metabase URL',
      placeholder: 'https://metabase.acme.com',
      initialValue: current?.url ?? '',
      validate: (value) =>
        MetabaseConfigSchema.shape.url.safeParse(value.trim()).success
          ? undefined
          : 'An http(s) URL',
    })
  ).replace(/\/+$/, '')
  const stored = orFail(
    await services.loadSecret(project.name, METABASE_API_KEY),
    describeSecretError,
  )
  const keepKey = stored !== null && (await askConfirm('Keep the stored API key?', true))
  const apiKey =
    keepKey && stored !== null
      ? stored.value
      : await askSecret(
          'Metabase API key (Admin → Settings → Authentication → API keys; stored in the keychain)',
        )

  const progress = spinner()
  progress.start('Connecting to Metabase')
  const databases = await verify(services, url, apiKey)
  if (!databases.ok) {
    progress.stop('Could not connect to Metabase')
    fail(databases.error)
  }
  progress.stop(`Connected: ${databases.value.length} database(s) in Metabase`)

  const databaseIds: Record<string, number> = {}
  for (const database of project.integrations.databases ?? []) {
    const choice = await askChoice<number>(
      `Which Metabase database is "${database.name}"?`,
      [
        { value: 0, label: 'None' },
        ...databases.value.map((candidate) => ({
          value: candidate.id,
          label: candidate.name,
          hint: `${candidate.engine}, id ${candidate.id}`,
        })),
      ],
      current?.databaseIds[database.name] ?? 0,
    )
    if (choice !== 0) databaseIds[database.name] = choice
  }
  if ((project.integrations.databases ?? []).length === 0) {
    log.warn('This project has no databases yet: map them later with `project add metabase`.')
  }
  const collection = await askText({
    message: 'Collection id for new questions (empty for the root collection)',
    initialValue: current?.collectionId === undefined ? '' : String(current.collectionId),
    validate: (value) =>
      value.trim() === '' || /^\d+$/.test(value.trim()) ? undefined : 'A number',
  })

  const config = MetabaseConfigSchema.parse({
    type: 'metabase',
    url,
    databaseIds,
    ...(collection.trim() === '' ? {} : { collectionId: Number(collection) }),
  })
  const updated = orFail(withMetabase(project, config), String)
  if (!keepKey) {
    orFail(await services.saveSecret(project.name, METABASE_API_KEY, apiKey), describeSecretError)
  }
  orFail(await services.projects.save(updated), describeProjectError)
  return updated
}
