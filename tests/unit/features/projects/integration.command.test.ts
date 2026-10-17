import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '#src/core/kernel/index.ts'
import { FakeCli, testDatabase, testProject, withDatabases } from '#tests/support/fake-cli.ts'
import { sampleOverview } from '#tests/support/jira-overview.ts'

describe('ticketsmith project add|remove', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
    cli.discovery.overview = ok(sampleOverview)
  })
  afterEach(() => cli.cleanup())

  const load = async () => {
    const project = await cli.services.projects.load('acme')
    if (!project.ok) throw new Error('missing')
    return project.value
  }

  it('adds a ticket source from flags and investigates it', async () => {
    await cli.withProject(testProject(null))
    await cli.secrets.set({ project: 'acme', name: 'jira-token' }, 'token')
    const flags = ['--site', 'example.atlassian.net', '--email', 'me@acme.test', '--auth', 'scoped']

    expect(await cli.run('project', 'add', 'tickets', ...flags)).toBeNull()
    expect((await load()).integrations.tickets?.siteUrl).toBe('https://example.atlassian.net')
    expect(cli.stdout).toContain('tickets ready in project "acme"')
  })

  it('adds a JIRA Data Center source with its context path and a personal access token', async () => {
    await cli.withProject(testProject(null))
    await cli.secrets.set({ project: 'acme', name: 'jira-token' }, 'pat')
    expect(
      (await cli.run('project', 'add', 'tickets', '--deployment', 'data-center'))?.message,
    ).toMatch(/needs --site/)
    expect(
      await cli.run(
        'project',
        'add',
        'tickets',
        '--deployment',
        'data-center',
        '--site',
        'https://jira.example.com/jira/',
      ),
    ).toBeNull()
    expect((await load()).integrations.tickets).toEqual({
      type: 'jira-data-center',
      siteUrl: 'https://jira.example.com/jira',
      customFields: {},
      allowWrites: false,
    })
    expect(cli.connections.at(-1)?.token).toBe('pat')
  })

  it('removes an integration with its secret, catalog and knowledge', async () => {
    await cli.withProject(testProject({ projectKey: 'OPS' }))
    await cli.run('project', 'refresh')
    const paths = await cli.services.projects.locate('acme')
    if (!paths.ok) throw new Error('missing')

    expect((await cli.run('project', 'remove', 'tickets'))?.message).toMatch(/--yes/)
    expect(await cli.run('project', 'remove', 'tickets', '--yes')).toBeNull()

    expect((await load()).integrations).toEqual({})
    expect(cli.secrets.values.has('acme/jira-token')).toBe(false)
    // ticket-types.md is the team's curated classification: it stays.
    expect(await readdir(paths.value.knowledgeDir)).toEqual(['brief.md', 'ticket-types.md'])
    await cli.run('--json', 'project', 'status')
    expect(JSON.parse(cli.stdout).integrations).toEqual([
      { integration: 'tickets', configured: false, investigation: null },
      { integration: 'databases', configured: false, investigation: null },
      { integration: 'repos', configured: false, investigation: null },
      { integration: 'metabase', configured: false, investigation: null },
    ])
  })

  it('refuses to remove what is not configured', async () => {
    await cli.withProject(testProject(null))
    expect((await cli.run('project', 'remove', 'tickets', '--yes'))?.message).toMatch(
      /not configured/,
    )
  })
})

describe('ticketsmith project add|remove databases', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject(null))
  })
  afterEach(() => cli.cleanup())

  const flags = (name: string) => [
    '--name',
    name,
    '--host',
    `${name}.internal`,
    '--database',
    'app',
    '--user',
    'reader',
    '--group',
    'shards',
  ]

  it('adds a database from flags with its password from the environment-or-keychain, then investigates', async () => {
    expect((await cli.run('project', 'add', 'databases', ...flags('shard1')))?.message).toMatch(
      /TICKETSMITH_DB_SHARD1/,
    )

    await cli.secrets.set({ project: 'acme', name: 'db-shard1' }, 'pw1')
    cli.databases.get('shard1').canWrite = true
    expect(await cli.run('project', 'add', 'databases', ...flags('shard1'))).toBeNull()
    expect(cli.stderr).toContain('can write')
    const project = await cli.services.projects.load('acme')
    expect(project.ok && project.value.integrations.databases).toEqual([
      {
        name: 'shard1',
        type: 'mysql',
        host: 'shard1.internal',
        port: 3306,
        database: 'app',
        user: 'reader',
        group: 'shards',
        ssl: false,
        allowChanges: false,
      },
    ])
    expect(cli.databases.connections[0]).toEqual({ name: 'shard1', password: 'pw1' })
  })

  it('adds a PostgreSQL database with its default port and schema', async () => {
    await cli.secrets.set({ project: 'acme', name: 'db-ledger' }, 'pw')
    expect(
      await cli.run(
        'project',
        'add',
        'databases',
        '--engine',
        'postgres',
        '--name',
        'ledger',
        '--host',
        'ledger.internal',
        '--database',
        'ledger',
        '--user',
        'reader',
      ),
    ).toBeNull()
    const project = await cli.services.projects.load('acme')
    expect(project.ok && project.value.integrations.databases?.[0]).toEqual({
      name: 'ledger',
      type: 'postgres',
      host: 'ledger.internal',
      port: 5432,
      database: 'ledger',
      user: 'reader',
      schema: 'public',
      ssl: false,
      allowChanges: false,
    })
  })

  it('removes one database or all of them, with their secrets', async () => {
    await cli.withProject(
      withDatabases(testProject(null), [testDatabase('shard1'), testDatabase('shard2')]),
    )

    expect(await cli.run('project', 'remove', 'databases', '--db', 'shard1', '--yes')).toBeNull()
    expect(cli.secrets.values.has('acme/db-shard1')).toBe(false)
    expect(cli.secrets.values.has('acme/db-shard2')).toBe(true)

    expect(await cli.run('project', 'remove', 'databases', '--yes')).toBeNull()
    expect(cli.secrets.values.has('acme/db-shard2')).toBe(false)
    const project = await cli.services.projects.load('acme')
    expect(project.ok && project.value.integrations).toEqual({})
  })
})

describe('ticketsmith project agent', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject(null))
  })
  afterEach(() => cli.cleanup())

  it('shows the agent settings and switches to the SDK only with an API key', async () => {
    expect(await cli.run('project', 'agent')).toBeNull()
    expect(cli.stdout).toContain('runtime: claude-code')

    expect((await cli.run('project', 'agent', '--runtime', 'sdk'))?.message).toMatch(
      /TICKETSMITH_ANTHROPIC_API_KEY/,
    )
    await cli.secrets.set({ project: 'acme', name: 'anthropic-api-key' }, 'sk-test')
    expect(
      await cli.run('project', 'agent', '--runtime', 'sdk', '--budget', '1.5', '--timeout', '10'),
    ).toBeNull()
    const project = await cli.services.projects.load('acme')
    expect(project.ok && project.value.agent).toEqual({
      runtime: 'sdk',
      maxBudgetUsd: 1.5,
      timeoutMinutes: 10,
    })
    expect((await cli.run('project', 'agent', '--budget', 'lots'))?.message).toMatch(
      /Invalid agent settings/,
    )
  })
})
