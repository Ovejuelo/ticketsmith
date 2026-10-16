import type { Result } from '../kernel/index.ts'

/** `jira-token`, or `db-<database name>` for each configured database. */
export type SecretName = 'jira-token' | `db-${string}` | `git-host-${string}`

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
