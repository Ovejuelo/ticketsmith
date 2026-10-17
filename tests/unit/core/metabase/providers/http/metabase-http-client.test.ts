import { describe, expect, it } from 'vitest'
import { templateTags } from '#src/core/metabase/index.ts'
import { MetabaseHttpClient } from '#src/core/metabase/providers/http/index.ts'
import { FakeFetch } from '#tests/support/fake-fetch.ts'

const clientWith = (fake: FakeFetch) =>
  new MetabaseHttpClient({
    url: 'https://metabase.example.com/',
    apiKey: 'mb_key',
    fetch: fake.fetch,
  })

describe('MetabaseHttpClient', () => {
  it('authenticates with x-api-key and reads databases in both list shapes', async () => {
    const fake = new FakeFetch()
      .on('/api/user/current', { body: { common_name: 'Reports Bot', email: null } })
      .on(
        '/api/database',
        { body: { data: [{ id: 3, name: 'Billing', engine: 'mysql' }], total: 1 } },
        { body: [{ id: 4, name: 'Ledger', engine: 'postgres' }] },
      )
    const client = clientWith(fake)
    expect(await client.currentUser()).toEqual({ ok: true, value: { name: 'Reports Bot' } })
    expect(fake.requests[0]?.headers.get('x-api-key')).toBe('mb_key')
    expect(fake.requests[0]?.url.toString()).toBe('https://metabase.example.com/api/user/current')
    expect(await client.databases()).toEqual({
      ok: true,
      value: [{ id: 3, name: 'Billing', engine: 'mysql' }],
    })
    expect(await client.databases()).toMatchObject({ ok: true, value: [{ id: 4 }] })
  })

  it('creates a native question with its template tags', async () => {
    const fake = new FakeFetch().on('/api/card', { body: { id: 57, name: 'x' } })
    const sql = 'SELECT * FROM invoices WHERE created_at >= {{start_date}}'
    const created = await clientWith(fake).createCard({
      name: 'OPS-7: invoices',
      description: 'd',
      databaseId: 3,
      collectionId: 9,
      sql,
      templateTags: templateTags(sql),
    })
    expect(created).toEqual({
      ok: true,
      value: { id: 57, url: 'https://metabase.example.com/question/57' },
    })
    expect(fake.requests[0]?.method).toBe('POST')
    expect(fake.requests[0]?.body).toMatchObject({
      name: 'OPS-7: invoices',
      collection_id: 9,
      display: 'table',
      dataset_query: {
        type: 'native',
        database: 3,
        native: { query: sql, 'template-tags': { start_date: { type: 'date' } } },
      },
    })
  })

  it('maps HTTP errors', async () => {
    const fake = new FakeFetch()
      .on('/api/user/current', { status: 401, body: 'Unauthenticated' })
      .on('/api/card', { status: 400, body: { message: 'bad query' } })
    expect(await clientWith(fake).currentUser()).toMatchObject({
      ok: false,
      error: { kind: 'unauthorized' },
    })
    expect(
      await clientWith(fake).createCard({
        name: 'n',
        description: '',
        databaseId: 1,
        collectionId: null,
        sql: 'x',
        templateTags: {},
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'rejected', message: expect.stringContaining('bad query') },
    })
  })
})
