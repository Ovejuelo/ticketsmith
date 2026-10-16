import { describe, expect, it } from 'vitest'
import { apiBaseUrl, resolveCloudId } from '#src/core/tickets/providers/jira-cloud/api-base-url.ts'
import { FakeFetch } from '#tests/support/fake-fetch.ts'

describe('apiBaseUrl', () => {
  it('uses the gateway for scoped tokens and the site for classic ones', () => {
    expect(apiBaseUrl({ kind: 'scoped', cloudId: 'c1' })).toBe(
      'https://api.atlassian.com/ex/jira/c1',
    )
    expect(apiBaseUrl({ kind: 'classic', siteUrl: 'https://acme.atlassian.net' })).toBe(
      'https://acme.atlassian.net',
    )
  })
})

describe('resolveCloudId', () => {
  it('reads the cloudId from tenant_info', async () => {
    const fake = new FakeFetch().on('/_edge/tenant_info', { body: { cloudId: 'c1' } })
    expect(await resolveCloudId('https://acme.atlassian.net/', fake.fetch)).toEqual({
      ok: true,
      value: 'c1',
    })
    expect(fake.requests[0]?.url.toString()).toBe('https://acme.atlassian.net/_edge/tenant_info')
  })

  it('reports an unknown site', async () => {
    const fake = new FakeFetch().on('/_edge/tenant_info', { status: 404 })
    expect((await resolveCloudId('https://nope.atlassian.net', fake.fetch)).ok).toBe(false)
  })
})
