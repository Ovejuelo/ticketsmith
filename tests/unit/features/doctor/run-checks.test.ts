import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '#src/core/kernel/index.ts'
import { runChecks } from '#src/features/doctor/run-checks.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'

describe('doctor', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  const statuses = async () =>
    Object.fromEntries((await runChecks(cli.services, undefined)).map((c) => [c.name, c.status]))

  it('fails early without a project', async () => {
    expect(await statuses()).toEqual({ project: 'fail' })
    expect((await cli.run('doctor'))?.message).toBe('Some checks failed.')
  })

  it('reports a healthy scoped setup', async () => {
    await cli.withProject(testProject({ jql: 'project = OPS', boardId: 245 }))
    cli.discovery.board = ok({ id: 245, name: 'Support', type: 'kanban', projectKey: 'OPS' })

    expect(await statuses()).toEqual({
      project: 'ok',
      'token type': 'ok',
      token: 'ok',
      connection: 'ok',
      jql: 'ok',
      board: 'ok',
      databases: 'skip',
    })
    expect(await cli.run('doctor')).toBeNull()
  })

  it('warns about classic tokens, missing JQL and board scopes', async () => {
    await cli.withProject(testProject({ auth: 'classic', boardId: 245 }))
    cli.discovery.board = err({ kind: 'unauthorized', message: 'scope does not match' })

    expect(await statuses()).toMatchObject({ 'token type': 'warn', jql: 'warn', board: 'warn' })
  })

  it('checks only configured integrations', async () => {
    await cli.withProject(testProject(null))
    const checks = await runChecks(cli.services, undefined)
    expect(checks).toEqual([
      { name: 'project', status: 'ok', detail: '"acme" with no integrations yet' },
      {
        name: 'tickets',
        status: 'skip',
        detail: 'Not configured (`ticketsmith project add tickets`)',
      },
      {
        name: 'databases',
        status: 'skip',
        detail: 'Not configured (`ticketsmith project add databases`)',
      },
    ])
    expect(await cli.run('doctor')).toBeNull()
  })

  it('fails on rejected credentials', async () => {
    await cli.withProject()
    cli.source = new InMemoryTicketSource([], {
      identity: err({ kind: 'unauthorized', message: 'Unauthorized' }),
    })
    expect(await statuses()).toMatchObject({ connection: 'fail' })
  })

  it('checks every database: reachable, and whether the account can write', async () => {
    await cli.withProject(
      withDatabases(testProject(null), [
        testDatabase('shard1'),
        testDatabase('shard2'),
        testDatabase('shard3'),
      ]),
    )
    cli.databases.get('shard2').canWrite = true
    cli.databases.get('shard3').pingResult = err({
      kind: 'unreachable',
      database: 'shard3',
      message: 'ETIMEDOUT',
    })

    const checks = await runChecks(cli.services, undefined)
    expect(checks.filter((c) => c.name.startsWith('db ')).map((c) => [c.name, c.status])).toEqual([
      ['db shard1', 'ok'],
      ['db shard2', 'warn'],
      ['db shard3', 'fail'],
    ])
    expect(checks.find((c) => c.name === 'db shard3')?.detail).toMatch(/Is the VPN or tunnel up/)
  })
})
