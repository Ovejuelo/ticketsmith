import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_CATALOG, TableInfoSchema } from '#src/core/database/index.ts'
import { err, ok } from '#src/core/kernel/index.ts'
import { ProjectDatabase } from '#src/core/storage/index.ts'
import { investigateDatabases } from '#src/features/projects/investigate-databases.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'

const users = {
  name: 'users',
  comment: 'Contact: dba@acme.mx',
  estimatedRows: 1200,
  columns: [
    { name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, comment: '' },
    { name: 'account_id', type: 'int', nullable: false, key: 'MUL', default: null, comment: '' },
  ],
  foreignKeys: [{ column: 'account_id', referencesTable: 'accounts', referencesColumn: 'id' }],
  indexes: [],
}
const accounts = { ...users, name: 'accounts', comment: '', foreignKeys: [] }

describe('investigateDatabases', () => {
  let cli: FakeCli
  const project = withDatabases(testProject(null), [
    testDatabase('shard1', { group: 'shards' }),
    testDatabase('shard2', { group: 'shards' }),
    testDatabase('billing'),
  ])

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(project)
    cli.databases.get('shard1').schema = err({
      kind: 'unreachable',
      database: 'shard1',
      message: 'ECONNREFUSED',
    })
    cli.databases.get('shard2').schema = ok({ tables: [users, accounts] })
    cli.databases.get('billing').schema = ok({ tables: [accounts] })
  })
  afterEach(() => cli.cleanup())

  const run = async () => {
    const paths = await cli.services.projects.locate('acme')
    if (!paths.ok) throw new Error('missing')
    const db = ProjectDatabase.open(paths.value.sqlite)
    if (!db.ok) throw new Error(db.error.message)
    try {
      return {
        result: await investigateDatabases(cli.services, { project, paths: paths.value }, db.value),
        db: db.value,
        paths: paths.value,
      }
    } catch (error) {
      db.value[Symbol.dispose]()
      throw error
    }
  }

  it('introspects each group once, from its first reachable member', async () => {
    const { result, db, paths } = await run()
    expect(result).toEqual({
      ok: true,
      value: { summary: 'shards (2 databases), billing: 3 tables' },
    })
    expect([
      cli.databases.get('shard1').introspections,
      cli.databases.get('shard2').introspections,
    ]).toEqual([1, 1])

    const tables = db.catalog(
      DATABASE_CATALOG.integration,
      DATABASE_CATALOG.tableKind('shards'),
      TableInfoSchema,
    )
    expect(tables.ok && tables.value.map((t) => t.key)).toEqual(['accounts', 'users'])
    db[Symbol.dispose]()

    expect((await readdir(join(paths.knowledgeDir, 'databases'))).sort()).toEqual([
      'billing.md',
      'shards.md',
    ])
    const knowledge = await readFile(join(paths.knowledgeDir, 'databases', 'shards.md'), 'utf8')
    expect(knowledge).toContain(
      'Group of 2 databases sharing this schema: shard1, shard2. Investigated from shard2.',
    )
    expect(knowledge).toContain('- users (1 relations)')
    expect(knowledge).toContain('Foreign keys: account_id → accounts.id')
    expect(knowledge).toContain('Contact: [EMAIL_1]@acme.mx')
    expect(knowledge).not.toContain('db.internal')
    expect([...cli.databases.connections].every((c) => c.password.startsWith('pw-'))).toBe(true)
    expect(cli.databases.get('shard2').disposed).toBe(true)
  })

  it('fails the step when no member of a target can be read', async () => {
    cli.databases.get('shard2').schema = err({
      kind: 'auth',
      database: 'shard2',
      message: 'denied',
    })
    const { result, db } = await run()
    db[Symbol.dispose]()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/^shards: .*unreachable.*rejected the credentials/)
  })
})
