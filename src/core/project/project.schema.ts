import { z } from 'zod'
import { ALL_MASK_KINDS } from '../security/index.ts'

// Project names become directory names and keychain keys, so keep them path-safe.
export const ProjectNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Use lowercase letters, digits, "-" or "_"')

export const JiraAuthKindSchema = z.enum(['scoped', 'classic'])
export type JiraAuthKind = z.infer<typeof JiraAuthKindSchema>

export const JiraCloudSourceConfigSchema = z
  .object({
    type: z.literal('jira-cloud'),
    /** Site origin, e.g. https://acme.atlassian.net */
    siteUrl: z.url({ protocol: /^https$/ }),
    email: z.email(),
    auth: JiraAuthKindSchema,
    /** Required for scoped tokens: their calls go through api.atlassian.com/ex/jira/{cloudId}. */
    cloudId: z.string().min(1).optional(),
    projectKey: z.string().min(1).optional(),
    boardId: z.number().int().positive().optional(),
    jql: z.string().min(1).optional(),
    /** Readable alias → custom field id, e.g. { "module": "customfield_10042" }. */
    customFields: z.record(z.string(), z.string().regex(/^customfield_\d+$/)).default({}),
  })
  .refine((config) => config.auth !== 'scoped' || config.cloudId !== undefined, {
    message: 'cloudId is required when auth is "scoped"',
    path: ['cloudId'],
  })
export type JiraCloudSourceConfig = z.infer<typeof JiraCloudSourceConfigSchema>

export const TicketSourceConfigSchema = z.discriminatedUnion('type', [JiraCloudSourceConfigSchema])
export type TicketSourceConfig = z.infer<typeof TicketSourceConfigSchema>

const isValidRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern, 'g')
    return true
  } catch {
    return false
  }
}

/** What gets masked before data reaches an LLM. Defaults to every built-in detector. */
export const MaskingConfigSchema = z
  .object({
    detectors: z.array(z.enum(ALL_MASK_KINDS)).default([...ALL_MASK_KINDS]),
    custom: z
      .array(
        z.object({
          label: z.string().min(1),
          pattern: z.string().min(1).refine(isValidRegex, 'Invalid regular expression'),
        }),
      )
      .default([]),
    keepEmailDomains: z.boolean().default(true),
  })
  .default({ detectors: [...ALL_MASK_KINDS], custom: [], keepEmailDomains: true })
export type MaskingConfig = z.infer<typeof MaskingConfigSchema>

/** Integrations are optional and independent: a project may have any combination, or none. */
// Database and group names become keychain keys and knowledge file names: keep them path-safe.
export const DatabaseNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Use lowercase letters, digits, "-" or "_"')

export const MysqlDatabaseConfigSchema = z.object({
  name: DatabaseNameSchema,
  type: z.literal('mysql'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535).default(3306),
  database: z.string().min(1),
  user: z.string().min(1),
  /** Databases sharing one schema (e.g. billing's shards) share a group. */
  group: DatabaseNameSchema.optional(),
  ssl: z.boolean().default(false),
})

export const DatabaseConfigSchema = z.discriminatedUnion('type', [MysqlDatabaseConfigSchema])
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>

export const DatabasesSchema = z
  .array(DatabaseConfigSchema)
  .min(1)
  .superRefine((databases, context) => {
    const names = new Set<string>()
    databases.forEach((database, index) => {
      if (names.has(database.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate database name "${database.name}"`,
          path: [index, 'name'],
        })
      }
      names.add(database.name)
    })
    databases.forEach((database, index) => {
      if (database.group !== undefined && names.has(database.group)) {
        context.addIssue({
          code: 'custom',
          message: `Group "${database.group}" has the same name as a database`,
          path: [index, 'group'],
        })
      }
    })
  })

export const IntegrationsSchema = z.object({
  tickets: TicketSourceConfigSchema.optional(),
  databases: DatabasesSchema.optional(),
})
export type Integrations = z.infer<typeof IntegrationsSchema>

export const INTEGRATIONS = ['tickets', 'databases'] as const
export type Integration = (typeof INTEGRATIONS)[number]

export const ProjectSchema = z.object({
  version: z.literal(2),
  name: ProjectNameSchema,
  integrations: IntegrationsSchema.default({}),
  masking: MaskingConfigSchema,
})
export type Project = z.infer<typeof ProjectSchema>

export const configuredIntegrations = (project: Project): readonly Integration[] =>
  INTEGRATIONS.filter((integration) => project.integrations[integration] !== undefined)

/** Shape of phase-1 profiles (~/.config/ticketsmith/profiles/<name>.json), read only to migrate them. */
export const LegacyProfileSchema = z.object({
  version: z.literal(1),
  name: ProjectNameSchema,
  tickets: TicketSourceConfigSchema,
  masking: MaskingConfigSchema,
})

export const AppConfigSchema = z.object({
  activeProject: ProjectNameSchema.optional(),
  /** Projects living outside the default folder (e.g. cloned from git), by name → absolute path. */
  linked: z.record(z.string(), z.string()).default({}),
})
export type AppConfig = z.infer<typeof AppConfigSchema>

/** A schema to investigate: a group of databases sharing one schema, or one ungrouped database. */
export type DatabaseTarget = {
  readonly name: string
  readonly members: readonly DatabaseConfig[]
}

export const databaseTargets = (
  databases: readonly DatabaseConfig[],
): readonly DatabaseTarget[] => {
  const targets = new Map<string, DatabaseConfig[]>()
  for (const database of databases) {
    const name = database.group ?? database.name
    targets.set(name, [...(targets.get(name) ?? []), database])
  }
  return [...targets].map(([name, members]) => ({ name, members }))
}
