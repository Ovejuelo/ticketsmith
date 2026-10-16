import { describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { firstAvailable } from '#src/core/secrets/first-available.ts'
import { EnvSecretStore } from '#src/core/secrets/providers/env/env-secret-store.ts'
import { InMemorySecretStore } from '#tests/support/in-memory-secret-store.ts'

const key = { project: 'acme', name: 'jira-token' } as const

describe('firstAvailable', () => {
  it('returns the first store that has the secret, with its source', async () => {
    const env = new EnvSecretStore({ TICKETSMITH_JIRA_TOKEN: 'from-env' })
    const keychain = new InMemorySecretStore('keychain', { 'acme/jira-token': 'from-keychain' })

    expect(await firstAvailable([env, keychain], key)).toEqual(
      ok({ value: 'from-env', source: 'environment' }),
    )
  })

  it('falls through empty stores', async () => {
    const env = new EnvSecretStore({ TICKETSMITH_JIRA_TOKEN: '' })
    const keychain = new InMemorySecretStore('keychain', { 'acme/jira-token': 'from-keychain' })

    expect(await firstAvailable([env, keychain], key)).toEqual(
      ok({ value: 'from-keychain', source: 'keychain' }),
    )
  })

  it('returns null when no store has it', async () => {
    expect(await firstAvailable([new EnvSecretStore({})], key)).toEqual(ok(null))
  })
})
