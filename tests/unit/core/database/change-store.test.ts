import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ChangeRequest, ChangeStore } from '#src/core/database/index.ts'

const change: ChangeRequest = {
  id: 'cr-0000000a',
  database: 'shard1',
  ticket: 'OPS-7',
  reason: 'Close the account as requested.',
  sql: "UPDATE `accounts` SET `status` = 'inactive' WHERE `id` = 7",
  kind: 'update',
  table: 'accounts',
  preflight: { rows: 1, sample: [], usesIndex: true },
  rollbackSql: null,
  status: 'proposed',
  createdAt: '2026-10-17T10:00:00.000Z',
  expiresAt: '2026-10-17T11:00:00.000Z',
}

describe('ChangeStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ticketsmith-changes-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('reports a corrupt file as unreadable and lists the rest', async () => {
    const store = new ChangeStore(dir)
    await store.save(change)
    await writeFile(join(dir, 'cr-deadbeef.json'), '{broken')

    expect(await store.load('cr-deadbeef')).toEqual({
      ok: false,
      error: 'Change cr-deadbeef is unreadable: it is not valid JSON.',
    })
    expect(await store.list()).toEqual([change])
  })
})
