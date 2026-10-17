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
    /** L2: comments and transitions posted by a person from the CLI (token needs write:jira-work). */
    allowWrites: z.boolean().default(false),
  })
  .refine((config) => config.auth !== 'scoped' || config.cloudId !== undefined, {
    message: 'cloudId is required when auth is "scoped"',
    path: ['cloudId'],
  })
export type JiraCloudSourceConfig = z.infer<typeof JiraCloudSourceConfigSchema>

/** JIRA Data Center / Server: REST API v2 with a personal access token (Bearer). */
export const JiraDataCenterSourceConfigSchema = z.object({
  type: z.literal('jira-data-center'),
  /** Base URL, with the context path if any, e.g. https://jira.acme.com or https://acme.com/jira */
  siteUrl: z.url({ protocol: /^https$/ }),
  projectKey: z.string().min(1).optional(),
  boardId: z.number().int().positive().optional(),
  jql: z.string().min(1).optional(),
  customFields: z.record(z.string(), z.string().regex(/^customfield_\d+$/)).default({}),
  /** L2: comments and transitions posted by a person from the CLI. */
  allowWrites: z.boolean().default(false),
})
export type JiraDataCenterSourceConfig = z.infer<typeof JiraDataCenterSourceConfigSchema>

export const TicketSourceConfigSchema = z.discriminatedUnion('type', [
  JiraCloudSourceConfigSchema,
  JiraDataCenterSourceConfigSchema,
])
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
  /** The agent may propose changes here (db_propose_change); a human still approves each one. */
  allowChanges: z.boolean().default(false),
})

export const PostgresDatabaseConfigSchema = z.object({
  name: DatabaseNameSchema,
  type: z.literal('postgres'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  /** The schema investigated and searched first (search_path). */
  schema: z.string().min(1).default('public'),
  group: DatabaseNameSchema.optional(),
  ssl: z.boolean().default(false),
  allowChanges: z.boolean().default(false),
})

export const DatabaseConfigSchema = z.discriminatedUnion('type', [
  MysqlDatabaseConfigSchema,
  PostgresDatabaseConfigSchema,
])
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
    const groupTypes = new Map<string, string>()
    databases.forEach((database, index) => {
      if (database.group === undefined) return
      const type = groupTypes.get(database.group)
      if (type !== undefined && type !== database.type) {
        context.addIssue({
          code: 'custom',
          message: `Group "${database.group}" mixes ${type} and ${database.type}; a group shares one schema, so one engine`,
          path: [index, 'type'],
        })
      }
      groupTypes.set(database.group, database.type)
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
    /** The agent may change code here, in a worktree per ticket (`ticketsmith code`); you approve pushes. */
    allowCodeChanges: z.boolean().default(false),
    /** Branch name for a ticket: {key} and {slug} (from the ticket summary) are replaced. */
    branchPattern: z
      .string()
      .regex(/^[A-Za-z0-9._/{}-]+$/, 'Use letters, digits, ".", "_", "/", "-" and {key}/{slug}')
      .refine((pattern) => pattern.includes('{key}'), 'The pattern must include {key}')
      .default('fix/{key}-{slug}'),
    /** Where pull requests go (default: the fix branch). */
    prTarget: BranchNameSchema.optional(),
    /** Branch name for new functionality (`ticketsmith feature`), from the feature branch. */
    featureBranchPattern: z
      .string()
      .regex(/^[A-Za-z0-9._/{}-]+$/, 'Use letters, digits, ".", "_", "/", "-" and {key}/{slug}')
      .refine((pattern) => pattern.includes('{key}'), 'The pattern must include {key}')
      .default('feature/{key}-{slug}'),
    /** Where new-functionality pull requests go (default: the feature branch). */
    featurePrTarget: BranchNameSchema.optional(),
    /** Pull request host; detected from the URL when absent (github.com, bitbucket.org). */
    host: z
      .object({
        type: z.enum(['github', 'bitbucket-cloud', 'none']),
        /** API base for self-hosted instances, e.g. https://github.acme.dev/api/v3 */
        apiUrl: z.url({ protocol: /^https$/ }).optional(),
      })
      .optional(),
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

/** Metabase, where report queries become saved questions (`ticketsmith metabase publish`). */
export const MetabaseConfigSchema = z.object({
  type: z.literal('metabase'),
  /** The Metabase site, e.g. https://metabase.acme.com */
  url: z.url({ protocol: /^https?$/ }),
  /** Project database name → its database id in Metabase. */
  databaseIds: z.record(DatabaseNameSchema, z.number().int().positive()).default({}),
  /** The collection new questions go to (default: the API key's root collection). */
  collectionId: z.number().int().positive().optional(),
})
export type MetabaseConfig = z.infer<typeof MetabaseConfigSchema>

export const IntegrationsSchema = z.object({
  tickets: TicketSourceConfigSchema.optional(),
  databases: DatabasesSchema.optional(),
  repos: RepositoriesSchema.optional(),
  metabase: MetabaseConfigSchema.optional(),
})
export type Integrations = z.infer<typeof IntegrationsSchema>

export const INTEGRATIONS = ['tickets', 'databases', 'repos', 'metabase'] as const
export type Integration = (typeof INTEGRATIONS)[number]

export const AGENT_RUNTIMES = ['claude-code', 'sdk'] as const

/** What runs the agent, and limits for agent runs (`process`, deep repository analysis). */
export const AgentConfigSchema = z
  .object({
    /**
     * `claude-code`: the installed Claude Code, signed in with your plan. `sdk`: the Claude Agent
     * SDK with an Anthropic API key, for unattended runs (CI, evals).
     */
    runtime: z.enum(AGENT_RUNTIMES).default('claude-code'),
    /** A Claude Code model alias or name (default: the user's Claude Code default). */
    model: z.string().min(1).optional(),
    /** Per run; Claude Code checks it between turns, so a run can end slightly above it. */
    maxBudgetUsd: z.number().positive().max(100).default(3),
    timeoutMinutes: z.number().int().positive().max(240).default(20),
  })
  .default({ runtime: 'claude-code', maxBudgetUsd: 3, timeoutMinutes: 20 })
export type AgentConfig = z.infer<typeof AgentConfigSchema>

/** Classification (rules first, then a short LLM run when they are unsure). */
export const ClassificationConfigSchema = z
  .object({ maxBudgetUsd: z.number().positive().max(5).default(0.3) })
  .default({ maxBudgetUsd: 0.3 })

/** Limits for code changes (`ticketsmith code`). */
export const CodeConfigSchema = z
  .object({ testTimeoutMinutes: z.number().int().positive().max(120).default(15) })
  .default({ testTimeoutMinutes: 15 })

/** Limits for approved database changes. */
export const ChangesConfigSchema = z
  .object({ maxRows: z.number().int().positive().max(10_000).default(100) })
  .default({ maxRows: 100 })

export const ProjectSchema = z.object({
  version: z.literal(2),
  name: ProjectNameSchema,
  integrations: IntegrationsSchema.default({}),
  masking: MaskingConfigSchema,
  agent: AgentConfigSchema,
  changes: ChangesConfigSchema,
  code: CodeConfigSchema,
  classification: ClassificationConfigSchema,
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
