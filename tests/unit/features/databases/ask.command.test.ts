import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { emptyResult } from '#tests/support/fake-database.ts'

describe('ticketsmith db ask', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('uses the only database by default and prints a table', async () => {
    await cli.withProject(withDatabases(testProject(null), [testDatabase('main')]))
    cli.databases.get('main').answer = () =>
      ok({ ...emptyResult, columns: ['id', 'name'], rows: [{ id: 1, name: 'Ana' }] })

    expect(await cli.run('db', 'ask', 'SELECT id, name FROM users')).toBeNull()
    expect(cli.stdout).toContain('| id | name |\n| --- | --- |\n| 1 | Ana |')
    expect(cli.stdout).toContain('1 row(s) from main')
    expect(cli.databases.get('main').disposed).toBe(true)
  })

  it('requires --db or --group with several databases, and rejects unsafe SQL', async () => {
    await cli.withProject(withDatabases(testProject(null), [testDatabase('a'), testDatabase('b')]))
    expect((await cli.run('db', 'ask', 'SELECT 1'))?.message).toMatch(
      /Pass --db <name> or --group <name>/,
    )
    expect((await cli.run('db', 'ask', 'DELETE FROM t', '--db', 'a'))?.message).toMatch(
      /Query rejected/,
    )
    expect(
      (await cli.run('db', 'ask', 'SELECT 1', '--db', 'a', '--limit', '5000'))?.message,
    ).toMatch(/at most 1000/)
  })

  it('runs on a whole group', async () => {
    await cli.withProject(
      withDatabases(testProject(null), [
        testDatabase('shard1', { group: 'shards' }),
        testDatabase('shard2', { group: 'shards' }),
      ]),
    )
    await cli.run('db', 'ask', 'SELECT 1 AS x', '--group', 'shards')
    expect(cli.stdout).toContain('## shard1')
    expect(cli.stdout).toContain('## shard2')
  })

  it('explains how to add databases when there are none', async () => {
    await cli.withProject(testProject(null))
    expect((await cli.run('db', 'ask', 'SELECT 1'))?.message).toMatch(/project add databases/)
  })
})
