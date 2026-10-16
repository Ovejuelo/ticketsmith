import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '#src/core/kernel/index.ts'
import { runChecks } from '#src/features/doctor/run-checks.ts'
import {
  FakeCli,
  testDatabase,
  testProject,
  testRepository,
  withDatabases,
  withRepositories,
} from '#tests/support/fake-cli.ts'
import { TestRemote } from '#tests/support/git-repos.ts'
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
      agent: 'ok',
      repos: 'skip',
    })
    expect(await cli.run('doctor')).toBeNull()
  })

  it('checks the agent that runs `process`: installed and signed in', async () => {
    await cli.withProject(testProject({ jql: 'project = OPS' }))
    cli.agent.status = ok({ version: '2.1.301', loggedIn: false, authMethod: undefined })
    const checks = await runChecks(cli.services, undefined)
    expect(checks.find((check) => check.name === 'agent')).toEqual({
      name: 'agent',
      status: 'fail',
      detail: 'Claude Code 2.1.301 is not signed in: run `claude` and log in',
    })

    cli.agent.status = err({ kind: 'not-installed' })
    expect(
      (await runChecks(cli.services, undefined)).find((check) => check.name === 'agent'),
    ).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('npm i -g @anthropic-ai/claude-code'),
    })
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
      { name: 'repos', status: 'skip', detail: 'Not configured (`ticketsmith project add repos`)' },
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

describe('runChecks: repositories', () => {
  let cli: FakeCli
  let remote: TestRemote
  beforeEach(async () => {
    cli = await FakeCli.create()
    remote = new TestRemote({ fixture: 'api-express' })
  })
  afterEach(async () => {
    remote[Symbol.dispose]()
    await cli.cleanup()
  })

  it('checks remote access, base branches and the clone', async () => {
    await cli.withProject(
      withRepositories(testProject(null), [
        testRepository('api', { url: remote.url }),
        testRepository('gone', { url: 'file:///nonexistent/acme/gone' }),
        testRepository('web', { url: remote.url, branches: { fix: 'master', feature: 'main' } }),
      ]),
    )
    const before = await runChecks(cli.services, undefined)
    expect(before.filter((check) => check.name.startsWith('repo '))).toEqual([
      {
        name: 'repo api',
        status: 'warn',
        detail: 'Reachable, but not cloned yet: run `ticketsmith project refresh repos`',
      },
      { name: 'repo gone', status: 'fail', detail: expect.stringContaining('Cannot reach') },
      {
        name: 'repo web',
        status: 'fail',
        detail: 'Base branch(es) missing on the remote: master',
      },
    ])

    await cli.run('project', 'refresh', 'repos')
    const after = await runChecks(cli.services, undefined)
    expect(after.find((check) => check.name === 'repo api')).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^Reachable; clone at main [0-9a-f]{7} \(\d{4}-\d{2}-\d{2}\)$/),
    })
  })
})
