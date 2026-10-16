import { ok, type Result } from '#src/core/kernel/index.ts'
import type { SecretKey, SecretStore, SecretStoreError } from '#src/core/secrets/index.ts'

export class InMemorySecretStore implements SecretStore {
  readonly source: string
  readonly values = new Map<string, string>()

  constructor(source = 'memory', initial: Readonly<Record<string, string>> = {}) {
    this.source = source
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value)
  }

  static keyOf(key: SecretKey): string {
    return `${key.project}/${key.name}`
  }

  async get(key: SecretKey): Promise<Result<string | null, SecretStoreError>> {
    return ok(this.values.get(InMemorySecretStore.keyOf(key)) ?? null)
  }

  async set(key: SecretKey, value: string): Promise<Result<void, SecretStoreError>> {
    this.values.set(InMemorySecretStore.keyOf(key), value)
    return ok(undefined)
  }

  async delete(key: SecretKey): Promise<Result<void, SecretStoreError>> {
    this.values.delete(InMemorySecretStore.keyOf(key))
    return ok(undefined)
  }
}
