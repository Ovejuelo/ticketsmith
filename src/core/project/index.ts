export { describeProjectError } from './describe-error.ts'
export { type MigrationReport, migrateLegacyProfiles } from './migrate-profiles.ts'
export { type Paths, type ProjectPaths, projectPaths, resolvePaths } from './paths.ts'
export {
  type AppConfig,
  BranchNameSchema,
  configuredIntegrations,
  type DatabaseConfig,
  DatabaseConfigSchema,
  DatabaseNameSchema,
  type DatabaseTarget,
  databaseTargets,
  INTEGRATIONS,
  type Integration,
  type Integrations,
  type JiraAuthKind,
  JiraAuthKindSchema,
  type JiraCloudSourceConfig,
  type MaskingConfig,
  MaskingConfigSchema,
  type Project,
  ProjectNameSchema,
  ProjectSchema,
  type RepositoryConfig,
  RepositoryConfigSchema,
  RepositoryNameSchema,
  RepositoryUrlSchema,
  type TicketSourceConfig,
} from './project.schema.ts'
export { ProjectStore, type ProjectStoreError } from './project-store.ts'
export { normalizeSiteUrl } from './site-url.ts'
