import { describe, expect, it } from 'vitest'
import { databaseTargets, ProjectSchema } from '#src/core/project/index.ts'
import { testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'

const parse = (databases: unknown[]) =>
  ProjectSchema.safeParse({ ...testProject(null), integrations: { databases } })

describe('databases integration config', () => {
  it('accepts any number of named databases, optionally grouped', () => {
    const project = withDatabases(testProject(null), [
      testDatabase('shard1', { group: 'shards' }),
      testDatabase('shard2', { group: 'shards' }),
      testDatabase('billing'),
    ])
    expect(ProjectSchema.safeParse(project).success).toBe(true)
    expect(
      databaseTargets(project.integrations.databases ?? []).map((t) => [
        t.name,
        t.members.map((m) => m.name),
      ]),
    ).toEqual([
      ['shards', ['shard1', 'shard2']],
      ['billing', ['billing']],
    ])
  })

  it('defaults the port and TLS', () => {
    const result = parse([{ name: 'db', type: 'mysql', host: 'h', database: 'app', user: 'u' }])
    expect(result.success && result.data.integrations.databases?.[0]).toMatchObject({
      port: 3306,
      ssl: false,
    })
  })

  it('rejects duplicate names and groups named like a database', () => {
    expect(parse([testDatabase('a'), testDatabase('a')]).error?.issues[0]?.message).toMatch(
      /Duplicate database/,
    )
    expect(
      parse([testDatabase('a'), testDatabase('b', { group: 'a' })]).error?.issues[0]?.message,
    ).toMatch(/same name as a database/)
  })

  it('rejects an empty list and unsafe names', () => {
    expect(parse([]).success).toBe(false)
    expect(parse([testDatabase('../x')]).success).toBe(false)
  })
})
