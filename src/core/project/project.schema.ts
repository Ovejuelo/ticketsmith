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

// Repository names become clone folders and knowledge file names: keep them path-safe.
export const RepositoryNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Use lowercase letters, digits, "-" or "_"')

// A branch name as git accepts it, without anything that could read as an option or a range.
export const BranchNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._/-]+$/, 'Use letters, digits, ".", "_", "/" or "-"')
  .refine((name) => !name.startsWith('-') && !name.includes('..'), 'Not a valid branch name')

/** True when an http(s) URL carries a user or password, which would end up in project.yaml. */
const hasEmbeddedCredentials = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const parsed = new URL(url)
    return parsed.username !== '' || parsed.password !== ''
  } catch {
    return true
  }
}

/** Clone URL: ssh (git@host:org/repo.git, ssh://…), https or file. */
export const RepositoryUrlSchema = z
  .string()
  .regex(/^(git@[^\s:]+:\S+|(ssh|https?|file):\/\/\S+)$/, 'Use an ssh, https or file URL')
  .refine(
    (url) => !hasEmbeddedCredentials(url),
    'Remove the user or token from the URL: git credentials stay in your SSH agent or credential helper',
  )

export const GitRepositoryConfigSchema = z
  .object({
    name: RepositoryNameSchema,
    type: z.literal('git'),
    url: RepositoryUrlSchema,
    /** Base branch per kind of change; the clone follows `fix` (the code users run). */
    branches: z.object({ fix: BranchNameSchema, feature: BranchNameSchema }),
    /** Never pushed to (phase 8). Defaults to the base branches. */
    protectedBranches: z.array(BranchNameSchema).default([]),
    runtime: z.object({ node: z.string().min(1).optional() }).default({}),
    testCommand: z.string().min(1).optional(),
  })
  .transform((config) => ({
    ...config,
    protectedBranches:
      config.protectedBranches.length > 0
        ? config.protectedBranches
        : [...new Set([config.branches.fix, config.branches.feature])],
  }))

export const RepositoryConfigSchema = GitRepositoryConfigSchema
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>

export const RepositoriesSchema = z
  .array(RepositoryConfigSchema)
  .min(1)
  .superRefine((repos, context) => {
    const names = new Set<string>()
    repos.forEach((repo, index) => {
      if (names.has(repo.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate repository name "${repo.name}"`,
          path: [index, 'name'],
        })
      }
      names.add(repo.name)
    })
  })

export const IntegrationsSchema = z.object({
  tickets: TicketSourceConfigSchema.optional(),
  databases: DatabasesSchema.optional(),
  repos: RepositoriesSchema.optional(),
})
export type Integrations = z.infer<typeof IntegrationsSchema>

export const INTEGRATIONS = ['tickets', 'databases', 'repos'] as const
export type Integration = (typeof INTEGRATIONS)[number]

/** Limits for agent runs (`process`, deep repository analysis). */
export const AgentConfigSchema = z
  .object({
    /** A Claude Code model alias or name (default: the user's Claude Code default). */
    model: z.string().min(1).optional(),
    /** Per run; Claude Code checks it between turns, so a run can end slightly above it. */
    maxBudgetUsd: z.number().positive().max(100).default(3),
    timeoutMinutes: z.number().int().positive().max(240).default(20),
  })
  .default({ maxBudgetUsd: 3, timeoutMinutes: 20 })
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const ProjectSchema = z.object({
  version: z.literal(2),
  name: ProjectNameSchema,
  integrations: IntegrationsSchema.default({}),
  masking: MaskingConfigSchema,
  agent: AgentConfigSchema,
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
