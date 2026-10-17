import type { Result } from '../kernel/index.ts'

/** `jira-token`, `db-<database name>` for each database, git host tokens and the agent's API key. */
export type SecretName =
  | 'jira-token'
  | 'anthropic-api-key'
  | 'metabase-api-key'
  | `db-${string}`
  | `git-host-${string}`

/** The Metabase API key (env: TICKETSMITH_METABASE_API_KEY). */
export const METABASE_API_KEY: SecretName = 'metabase-api-key'

/** The Anthropic API key of the Agent SDK runtime (env: TICKETSMITH_ANTHROPIC_API_KEY). */
export const ANTHROPIC_API_KEY: SecretName = 'anthropic-api-key'

export const databaseSecret = (database: string): SecretName => `db-${database}`

/** The pull-request API token for a git host, e.g. git-host-github-com. */
export const gitHostSecret = (hostname: string): SecretName =>
  `git-host-${hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

/** Environment variable that overrides a secret for every project (CI, evals). */
export const secretEnvVariable = (name: SecretName): string =>
  `TICKETSMITH_${name.toUpperCase().replaceAll('-', '_')}`

export type SecretKey = {
  readonly project: string
  readonly name: SecretName
}

export type SecretStoreError =
  | { readonly kind: 'read-only'; readonly source: string }
  | { readonly kind: 'unavailable'; readonly source: string; readonly message: string }

/** Where secrets live. Values never go to logs, prompts or output files. */
export interface SecretStore {
  /** Human-readable origin, shown by `doctor` (never the value). */
  readonly source: string
  get(key: SecretKey): Promise<Result<string | null, SecretStoreError>>
  set(key: SecretKey, value: string): Promise<Result<void, SecretStoreError>>
  delete(key: SecretKey): Promise<Result<void, SecretStoreError>>
}
