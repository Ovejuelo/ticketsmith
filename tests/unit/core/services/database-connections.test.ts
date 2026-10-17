import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseConnections } from '#src/core/services/index.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'

describe('DatabaseConnections', () => {
  let cli: FakeCli
  const project = withDatabases(testProject(null), [
    testDatabase('shard1', { group: 'shards' }),
    testDatabase('shard2', { group: 'shards' }),
  ])
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(project)
  })
  afterEach(() => cli.cleanup())

  it('reads each password only when that database is first used, and reuses the adapter', async () => {
    const connections = new DatabaseConnections(cli.services, project)
    expect(cli.databases.connections).toEqual([])
    const first = await connections.connect('shard2')
    const again = await connections.connect('shard2')
    expect(first.ok && again.ok && first.value === again.value).toBe(true)
    expect(cli.databases.connections).toEqual([{ name: 'shard2', password: 'pw-shard2' }])

    await connections[Symbol.asyncDispose]()
    expect(cli.databases.get('shard2').disposed).toBe(true)
  })

  it('opens one adapter when two calls race for the same database, and closes it', async () => {
    const connections = new DatabaseConnections(cli.services, project)
    const [first, second] = await Promise.all([
      connections.connect('shard1'),
      connections.connect('shard1'),
    ])
    expect(first.ok && second.ok && first.value === second.value).toBe(true)
    expect(cli.databases.connections).toEqual([{ name: 'shard1', password: 'pw-shard1' }])

    await connections[Symbol.asyncDispose]()
    expect(cli.databases.get('shard1').disposed).toBe(true)
  })

  it('tries again after a failed connection', async () => {
    cli.secrets.values.delete('acme/db-shard1')
    const connections = new DatabaseConnections(cli.services, project)
    expect((await connections.connect('shard1')).ok).toBe(false)
    cli.secrets.values.set('acme/db-shard1', 'pw-shard1')
    expect((await connections.connect('shard1')).ok).toBe(true)
  })

  it('resolves groups and explains unknown names', () => {
    const connections = new DatabaseConnections(cli.services, project)
    expect(connections.resolveTarget('shards')).toMatchObject({
      ok: true,
      value: [{ name: 'shard1' }, { name: 'shard2' }],
    })
    expect(connections.resolveTarget('shard1')).toMatchObject({
      ok: true,
      value: [{ name: 'shard1' }],
    })
    expect(connections.resolveTarget('nope')).toEqual({
      ok: false,
      error: 'Unknown database or group "nope". Known: shards (group: shard1, shard2).',
    })
  })

  it('explains a missing password', async () => {
    cli.secrets.values.delete('acme/db-shard1')
    expect(await new DatabaseConnections(cli.services, project).connect('shard1')).toEqual({
      ok: false,
      error:
        'No password stored for database "shard1". Run `ticketsmith project add databases` or set TICKETSMITH_DB_SHARD1.',
    })
  })
})
