import { AsyncEntry } from '@napi-rs/keyring'
import { err, ok, type Result } from '../../../kernel/index.ts'
import type { SecretKey, SecretStore, SecretStoreError } from '../../secret-store.port.ts'

const SERVICE = 'ticketsmith'

/** System keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). */
export class KeyringSecretStore implements SecretStore {
  readonly source = 'keychain'

  async get(key: SecretKey): Promise<Result<string | null, SecretStoreError>> {
    return this.#attempt(() => entryFor(key).getPassword())
  }

  async set(key: SecretKey, value: string): Promise<Result<void, SecretStoreError>> {
    return this.#attempt(() => entryFor(key).setPassword(value))
  }

  async delete(key: SecretKey): Promise<Result<void, SecretStoreError>> {
    const result = await this.#attempt(() => entryFor(key).deleteCredential())
    return result.ok ? ok(undefined) : result
  }

  async #attempt<T>(operation: () => Promise<T>): Promise<Result<T, SecretStoreError>> {
    try {
      return ok(await operation())
    } catch (error) {
      return err({ kind: 'unavailable', source: this.source, message: String(error) })
    }
  }
}

const entryFor = (key: SecretKey) => new AsyncEntry(SERVICE, `${key.project}/${key.name}`)
