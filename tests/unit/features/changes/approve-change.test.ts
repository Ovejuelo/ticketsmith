import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '#src/core/cli/index.ts'
import {
  type ChangeRequest,
  ChangeStore,
  DATABASE_CATALOG,
  type TableInfo,
} from '#src/core/database/index.ts'
import { ok } from '#src/core/kernel/index.ts'
import { withProjectDatabase } from '#src/core/storage/index.ts'
import { approveAndExecute, rejectChange } from '#src/features/changes/approve-change.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { emptyResult } from '#tests/support/fake-database.ts'

const accounts: TableInfo = {
  name: 'accounts',
  comment: '',
  estimatedRows: 10,
  columns: ['id', 'email', 'status'].map((name) => ({
    name,
    type: 'varchar(255)',
    nullable: true,
    key: name === 'id' ? 'PRI' : '',
    default: null,
    comment: '',
  })),
  foreignKeys: [],
  indexes: [],
}

const proposal = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: 'cr-0000000a',
  database: 'shard1',
  ticket: 'OPS-7',
  reason: 'Close the account as requested.',
  sql: "UPDATE `accounts` SET `status` = 'inactive' WHERE `id` = 7",
  kind: 'update',
  table: 'accounts',
  preflight: { rows: 1, sample: [{ id: 7, status: 'active' }], usesIndex: true },
  rollbackSql: 'old',
  status: 'proposed',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  ...overrides,
})

describe('approving a change', () => {
  let cli: FakeCli
  let shown: string[]
  const typing = (answer: string) => ({
    show: (text: string) => shown.push(text),
    confirm: async () => answer,
  })

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(
      withDatabases(testProject(null), [
        testDatabase('shard1', { allowChanges: true }),
        testDatabase('reports'),
      ]),
    )
    shown = []
    const opened = await openProject(cli.services, undefined)
    await withProjectDatabase(opened.paths.sqlite, (db) =>
      db.replaceCatalog(DATABASE_CATALOG.integration, DATABASE_CATALOG.tableKind('shard1'), [
        { key: 'accounts', data: accounts },
      ]),
    )
    cli.databases.get('shard1').answer = () =>
      ok({ ...emptyResult, rows: [{ id: 7, status: 'active' }] })
  })
  afterEach(() => cli.cleanup())

  const propose = async (change: ChangeRequest) => {
    const opened = await openProject(cli.services, undefined)
    await new ChangeStore(opened.paths.changesDir).save(change)
    return opened
  }

  it('re-checks, shows real values, requires the database name and runs it once', async () => {
    const opened = await propose(proposal())

    const result = await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))

    expect(result.ok).toBe(true)
    expect(cli.databases.get('shard1').executed).toEqual([
      "UPDATE `accounts` SET `status` = 'inactive' WHERE `id` = 7",
    ])
    expect(shown[0]).toContain("UPDATE `accounts` SET `status` = 'inactive' WHERE `id` = 7")
    expect(shown[0]).toContain('| 7 | active |')
    const stored = await new ChangeStore(opened.paths.changesDir).load('cr-0000000a')
    expect(stored.ok && stored.value).toMatchObject({
      status: 'executed',
      result: { affectedRows: 1 },
    })

    const dir = join(opened.paths.outDir, 'OPS-7', 'change-cr-0000000a')
    expect(await readFile(join(dir, 'rollback.sql'), 'utf8')).toContain(
      "UPDATE `accounts` SET `status` = 'active' WHERE `id` = 7;",
    )
    expect(await readFile(join(dir, 'change.sql'), 'utf8')).toContain('WHERE `id` = 7;')
    expect(cli.audit.entries.at(-1)).toMatchObject({
      tool: 'change_execute',
      ok: true,
      input: { id: 'cr-0000000a', rows: 1, sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(JSON.stringify(cli.audit.entries)).not.toContain('inactive')

    const again = await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))
    expect(again).toEqual({
      ok: false,
      error: 'Change cr-0000000a is executed; only proposed changes can be approved.',
    })
  })

  it('runs nothing when the name is not typed back', async () => {
    const opened = await propose(proposal())
    expect(await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('yes'))).toEqual({
      ok: false,
      error: 'Not approved: nothing ran.',
    })
    expect(cli.databases.get('shard1').executed).toEqual([])
  })

  it('refuses expired changes, moved data and databases that stopped allowing changes', async () => {
    const opened = await propose(proposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(
      (await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))).ok,
    ).toBe(false)

    await propose(proposal({ id: 'cr-0000000b' }))
    cli.databases.get('shard1').answer = () => ok({ ...emptyResult, rows: [{ id: 7 }, { id: 8 }] })
    expect(
      await approveAndExecute(cli.services, opened, 'cr-0000000b', typing('shard1')),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('now affects 2 rows instead of 1'),
    })

    await propose(proposal({ id: 'cr-0000000c', database: 'reports' }))
    expect(
      await approveAndExecute(cli.services, opened, 'cr-0000000c', typing('reports')),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer allows changes'),
    })
    expect(cli.databases.get('shard1').executed).toEqual([])
  })

  it('refuses a stored ticket that is not a key, before running anything', async () => {
    const opened = await propose(proposal({ ticket: '../../../ESCAPE' }))
    expect(
      await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1')),
    ).toMatchObject({ ok: false, error: expect.stringContaining('invalid ticket') })
    expect(cli.databases.get('shard1').executed).toEqual([])
  })

  it('runs nothing when the change expired while the prompt was open', async () => {
    const opened = await propose(proposal())
    let clock = Date.now()
    const io = {
      show: (text: string) => shown.push(text),
      confirm: async () => {
        clock += 2 * 60 * 60 * 1000
        return 'shard1'
      },
    }
    expect(
      await approveAndExecute(cli.services, opened, 'cr-0000000a', io, () => new Date(clock)),
    ).toMatchObject({ ok: false, error: expect.stringContaining('expired') })
    expect(cli.databases.get('shard1').executed).toEqual([])
  })

  it('records a rolled-back mismatch as failed', async () => {
    const opened = await propose(proposal())
    cli.databases.get('shard1').affectedRows = () => 3
    expect(
      await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1')),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'affected 3 rows instead of the 1 approved, so it was rolled back',
      ),
    })
    const stored = await new ChangeStore(opened.paths.changesDir).load('cr-0000000a')
    expect(stored.ok && stored.value.status).toBe('failed')
  })

  it('writes the INSERT rollback from the new AUTO_INCREMENT ids', async () => {
    const opened = await propose(
      proposal({
        sql: "INSERT INTO `accounts` (`email`, `status`) VALUES ('a@x.mx','new'), ('b@x.mx','new')",
        kind: 'insert',
        preflight: { rows: 2, sample: [], usesIndex: null },
        rollbackSql: null,
      }),
    )
    cli.databases.get('shard1').insertId = 41
    expect(
      (await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))).ok,
    ).toBe(true)
    const rollback = await readFile(
      join(opened.paths.outDir, 'OPS-7', 'change-cr-0000000a', 'rollback.sql'),
      'utf8',
    )
    expect(rollback).toContain(
      'DELETE FROM `accounts` WHERE `id` = 41;\nDELETE FROM `accounts` WHERE `id` = 42;',
    )
    expect(rollback).toContain('Ticketsmith never runs this script')
  })

  it('writes the INSERT rollback from the primary keys it listed', async () => {
    const opened = await propose(
      proposal({
        sql: "INSERT INTO `accounts` (`id`, `email`, `status`) VALUES ('77','a@x.mx','new')",
        kind: 'insert',
        preflight: { rows: 1, sample: [], usesIndex: null },
        rollbackSql: null,
      }),
    )
    expect(
      (await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))).ok,
    ).toBe(true)
    const rollback = await readFile(
      join(opened.paths.outDir, 'OPS-7', 'change-cr-0000000a', 'rollback.sql'),
      'utf8',
    )
    expect(rollback).toContain("DELETE FROM `accounts` WHERE `id` = '77';")
  })

  it('rejects without running, and the CLI never approves without a terminal', async () => {
    const opened = await propose(proposal())
    expect((await rejectChange(opened, 'cr-0000000a', 'not needed')).ok).toBe(true)
    expect(
      (await approveAndExecute(cli.services, opened, 'cr-0000000a', typing('shard1'))).ok,
    ).toBe(false)

    await propose(proposal({ id: 'cr-0000000d' }))
    expect((await cli.run('changes', 'approve', 'cr-0000000d'))?.message).toMatch(
      /interactive terminal/,
    )
    expect(await cli.run('changes', 'list')).toBeNull()
    expect(cli.stdout).toMatch(/cr-0000000d {2}proposed {2}shard1/)
    expect(cli.stdout).toMatch(/cr-0000000a {2}rejected/)
    expect(await cli.run('changes', 'show', 'cr-0000000d')).toBeNull()
    expect(cli.stdout).toContain('Affects:   1 row(s) of accounts (UPDATE)')
    expect((await cli.run('changes', 'show', '../../etc'))?.message).toMatch(/Invalid change id/)
  })
})
