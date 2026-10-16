import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const tickets = Array.from({ length: 5 }, (_, i) => makeTicket(`OPS-${i + 1}`))

describe('ticketsmith list', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ jql: 'project = OPS' }))
    cli.source = new InMemoryTicketSource(tickets, { pageSize: 2 })
  })
  afterEach(() => cli.cleanup())

  it('pages until the limit and prints a table', async () => {
    expect(await cli.run('list', '--limit', '3')).toBeNull()
    const lines = cli.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^KEY\s+TYPE\s+STATUS\s+PRIORITY\s+ASSIGNEE\s+SUMMARY$/)
    expect(lines.slice(1).map((line) => line.split(' ')[0])).toEqual(['OPS-1', 'OPS-2', 'OPS-3'])
    expect(cli.source.queries.map((q) => [q.query, q.limit])).toEqual([
      ['project = OPS', 3],
      ['project = OPS', 1],
    ])
  })

  it('prefers --jql over the profile', async () => {
    await cli.run('--json', 'list', '--jql', 'assignee = currentUser()')
    expect(cli.source.queries[0]?.query).toBe('assignee = currentUser()')
    expect(JSON.parse(cli.stdout)).toHaveLength(5)
  })

  it('rejects a non-numeric limit', async () => {
    expect((await cli.run('list', '--limit', 'many'))?.message).toMatch(/positive integer/)
  })

  it('falls back to the project JQL, and fails without any', async () => {
    await cli.withProject(testProject({ projectKey: 'OPS' }))
    await cli.run('list')
    expect(cli.source.queries.at(-1)?.query).toContain('project = "OPS"')

    await cli.withProject(testProject())
    expect((await cli.run('list'))?.message).toMatch(/No JQL configured/)
  })
})
