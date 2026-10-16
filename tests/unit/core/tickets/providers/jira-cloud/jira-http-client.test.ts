import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLogger } from '#src/core/kernel/index.ts'
import { JiraHttpClient } from '#src/core/tickets/providers/jira-cloud/jira-http-client.ts'
import { FakeFetch, instantSleep } from '#tests/support/fake-fetch.ts'

const Schema = z.object({ ok: z.boolean() })

const clientWith = (fake: FakeFetch, sleep = vi.fn(async (_ms: number) => {})) => ({
  sleep,
  client: new JiraHttpClient({
    baseUrl: 'https://api.atlassian.com/ex/jira/cloud-1/',
    email: 'me@acme.test',
    token: 'secret-token',
    logger: createLogger({ level: 'silent' }),
    fetch: fake.fetch,
    sleep,
    random: () => 1,
  }),
})

describe('JiraHttpClient', () => {
  it('sends Basic auth and query params to the base URL', async () => {
    const fake = new FakeFetch().on('/rest/api/3/myself', { body: { ok: true } })
    const { client } = clientWith(fake)

    expect(await client.get('/rest/api/3/myself', { a: 1, skip: undefined }, Schema)).toEqual({
      ok: true,
      value: { ok: true },
    })
    const [request] = fake.requests
    expect(request?.url.toString()).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself?a=1',
    )
    expect(request?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('me@acme.test:secret-token').toString('base64')}`,
    )
  })

  it.each([
    [400, 'invalid-query'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
  ])('maps HTTP %i to %s without retrying', async (status, kind) => {
    const fake = new FakeFetch().on('/x', { status, body: { errorMessages: ['nope'] } })
    const { client, sleep } = clientWith(fake)

    const result = await client.get('/x', {}, Schema)
    expect(result).toMatchObject({ ok: false, error: { kind } })
    expect(fake.requests).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('surfaces JIRA error messages', async () => {
    const fake = new FakeFetch().on('/x', {
      status: 400,
      body: { errorMessages: ['Bad JQL'], errors: { jql: 'Field "foo" does not exist' } },
    })
    const result = await clientWith(fake).client.get('/x', {}, Schema)
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-query', message: 'Bad JQL; Field "foo" does not exist' },
    })
  })

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const fake = new FakeFetch().on(
      '/x',
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 503 },
      { body: { ok: true } },
    )
    const { client, sleep } = clientWith(fake)

    expect((await client.get('/x', {}, Schema)).ok).toBe(true)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 1000])
  })

  it('gives up after the retry budget and reports rate limiting', async () => {
    const fake = new FakeFetch().on('/x', { status: 429, headers: { 'retry-after': '1' } })
    const { client } = clientWith(fake)

    expect(await client.get('/x', {}, Schema)).toEqual({
      ok: false,
      error: { kind: 'rate-limited', retryAfterMs: 1000 },
    })
    expect(fake.requests).toHaveLength(4)
  })

  it('retries network errors and reports timeouts clearly', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    const fake = new FakeFetch().on('/x', timeout)

    const result = await clientWith(fake).client.get('/x', {}, Schema)
    expect(result).toEqual({
      ok: false,
      error: { kind: 'network', message: 'Request timed out after 20000 ms' },
    })
    expect(fake.requests).toHaveLength(4)
  })

  it('reports schema mismatches with the failing path', async () => {
    const fake = new FakeFetch().on('/x', { body: { ok: 'yes' } })
    const result = await clientWith(fake).client.get('/x', {}, Schema)
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-response' } })
    if (!result.ok && result.error.kind === 'invalid-response') {
      expect(result.error.message).toContain('ok')
    }
  })

  it('never logs the token or the authorization header', async () => {
    const lines: string[] = []
    const fake = new FakeFetch().on('/x', { status: 500 }, { body: { ok: true } })
    const client = new JiraHttpClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.test',
      token: 'secret-token',
      logger: createLogger({ level: 'debug', destination: { write: (l) => lines.push(l) } }),
      fetch: fake.fetch,
      sleep: instantSleep,
    })

    await client.get('/x', {}, Schema)
    const output = lines.join('')
    expect(output).not.toBe('')
    expect(output).not.toContain('secret-token')
    expect(output).not.toContain(Buffer.from('me@acme.test:secret-token').toString('base64'))
  })
})
