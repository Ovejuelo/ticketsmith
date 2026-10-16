import { err, ok, type Result } from '../../../kernel/index.ts'
import {
  type SecretKey,
  type SecretStore,
  type SecretStoreError,
  secretEnvVariable,
} from '../../secret-store.port.ts'

type Env = Readonly<Record<string, string | undefined>>

/** Read-only fallback for CI and evals: `jira-token` → TICKETSMITH_JIRA_TOKEN (any project). */
export class EnvSecretStore implements SecretStore {
  readonly source = 'environment'
  readonly #env: Env

  constructor(env: Env) {
    this.#env = env
  }

  async get(key: SecretKey): Promise<Result<string | null, SecretStoreError>> {
    const value = this.#env[secretEnvVariable(key.name)]
    return ok(value !== undefined && value !== '' ? value : null)
  }

  async set(): Promise<Result<void, SecretStoreError>> {
    return err({ kind: 'read-only', source: this.source })
  }

  async delete(): Promise<Result<void, SecretStoreError>> {
    return err({ kind: 'read-only', source: this.source })
  }
}
