import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkForUpdate, isNewer } from '#src/core/cli/update-notice.ts'
import { FakeFetch } from '#tests/support/fake-fetch.ts'

const DAY = 24 * 60 * 60 * 1000

describe('isNewer', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.4.0', '0.5.0')).toBe(false)
  })

  it('never treats prereleases or junk as newer', () => {
    expect(isNewer('1.0.0-beta.1', '0.4.0')).toBe(false)
    expect(isNewer('latest', '0.4.0')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  let dir: string
  let cacheFile: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ticketsmith-update-'))
    cacheFile = join(dir, 'nested', 'update-check.json')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('reports a newer release and caches the answer', async () => {
    const http = new FakeFetch().on('/ticketsmith/latest', { body: { version: '0.5.0' } })

    const notice = await checkForUpdate({ current: '0.4.0', cacheFile, fetch: http.fetch, now: 1 })

    expect(notice).toBe('ticketsmith 0.5.0 is available (you have 0.4.0): npm i -g ticketsmith')
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({ checkedAt: 1, latest: '0.5.0' })
  })

  it('asks the registry at most once a day', async () => {
    const http = new FakeFetch().on('/ticketsmith/latest', { body: { version: '0.5.0' } })
    await checkForUpdate({ current: '0.4.0', cacheFile, fetch: http.fetch, now: 0 })
    await checkForUpdate({ current: '0.4.0', cacheFile, fetch: http.fetch, now: DAY - 1 })
    expect(http.requests).toHaveLength(1)

    await checkForUpdate({ current: '0.4.0', cacheFile, fetch: http.fetch, now: DAY })
    expect(http.requests).toHaveLength(2)
  })

  it('stays quiet when up to date', async () => {
    const http = new FakeFetch().on('/ticketsmith/latest', { body: { version: '0.4.0' } })
    expect(
      await checkForUpdate({ current: '0.4.0', cacheFile, fetch: http.fetch, now: 0 }),
    ).toBeNull()
  })

  it('stays quiet without network or with a broken cache', async () => {
    await writeFile(join(dir, 'broken.json'), '{nope')
    const http = new FakeFetch().on('/ticketsmith/latest', new Error('offline'))

    const notice = await checkForUpdate({
      current: '0.4.0',
      cacheFile: join(dir, 'broken.json'),
      fetch: http.fetch,
      now: 0,
    })

    expect(notice).toBeNull()
  })

  it('keeps the last known release when the registry fails', async () => {
    await writeFile(
      cacheFile.replace('nested/', ''),
      JSON.stringify({ checkedAt: 0, latest: '0.6.0' }),
    )
    const http = new FakeFetch().on('/ticketsmith/latest', { status: 503 })

    const notice = await checkForUpdate({
      current: '0.4.0',
      cacheFile: cacheFile.replace('nested/', ''),
      fetch: http.fetch,
      now: DAY,
    })

    expect(notice).toMatch(/0\.6\.0 is available/)
  })
})
