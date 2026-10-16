import { ok, type Result } from '../kernel/index.ts'
import type { SecretKey, SecretStore, SecretStoreError } from './secret-store.port.ts'

export type FoundSecret = { readonly value: string; readonly source: string }

/** Returns the secret from the first store that has it, in priority order. */
export const firstAvailable = async (
  stores: readonly SecretStore[],
  key: SecretKey,
): Promise<Result<FoundSecret | null, SecretStoreError>> => {
  for (const store of stores) {
    const result = await store.get(key)
    if (!result.ok) return result
    if (result.value !== null) return ok({ value: result.value, source: store.source })
  }
  return ok(null)
}
