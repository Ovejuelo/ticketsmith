import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ok } from '#src/core/kernel/index.ts'
import { ProjectDatabase } from '#src/core/storage/index.ts'
import { investigateTickets } from '#src/features/projects/investigate-tickets.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const overview = {
  key: 'OPS',
  name: 'Support L2',
  description: '',
  issueTypes: [
    {
      name: 'Incident',
      description: 'Production problem',
      subtask: false,
      statuses: [
        { name: 'Done', category: 'Done' },
        { name: 'Backlog', category: 'To Do' },
        { name: 'Validating', category: 'In Progress' },
        { name: 'To Do', category: 'To Do' },
      ],
    },
    { name: 'Sub-task', description: '', subtask: true, statuses: [] },
  ],
  components: [],
}

const openDb = (path: string): ProjectDatabase => {
  const db = ProjectDatabase.open(path)
  if (!db.ok) throw new Error(db.error.message)
  return db.value
}

describe('investigateTickets', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(
      testProject({ projectKey: 'OPS', customFields: { customer: 'customfield_1' } }),
    )
    cli.discovery.overview = ok(overview)
    cli.discovery.fields = ok([
      { id: 'customfield_1', name: 'Customer' },
      { id: 'customfield_2', name: 'Module' },
    ])
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-1', { type: 'Incident', summary: 'Cobro duplicado para ana@cliente.mx' }),
    ])
  })
  afterEach(() => cli.cleanup())

  const opened = async () => {
    const project = await cli.services.projects.load('acme')
    const paths = await cli.services.projects.locate('acme')
    if (!project.ok || !paths.ok) throw new Error('project missing')
    return { project: project.value, paths: paths.value }
  }

  it('stores the catalog and writes masked knowledge', async () => {
    const target = await opened()
    using db = openDb(target.paths.sqlite)

    const result = await investigateTickets(cli.services, target, db)

    expect(result).toEqual({
      ok: true,
      value: { summary: 'JIRA project OPS (Support L2): 1 issue types (Incident)' },
    })
    const types = db.catalog('tickets', 'issue-type', z.object({ examples: z.array(z.unknown()) }))
    expect(types.ok && types.value.map((entry) => [entry.key, entry.data.examples.length])).toEqual(
      [
        ['Incident', 1],
        ['Sub-task', 0],
      ],
    )
    const fields = db.catalog('tickets', 'custom-field', z.object({ alias: z.string().nullable() }))
    expect(fields.ok && fields.value.map((entry) => entry.data.alias)).toEqual(['customer', null])

    const knowledge = await readFile(join(target.paths.knowledgeDir, 'tickets', 'jira.md'), 'utf8')
    expect(knowledge).toContain('# JIRA: OPS · Support L2')
    expect(knowledge).toContain(
      '- **Statuses:** To Do: Backlog, To Do · In Progress: Validating · Done: Done',
    )
    expect(knowledge).toContain('OPS-1 · To Do · Cobro duplicado para [EMAIL_1]@cliente.mx')
    expect(knowledge).toContain('- `customer` = Customer (customfield_1)')
    expect(knowledge).not.toContain('ana@cliente.mx')
  })

  it('asks to pick the JIRA project first when there is none', async () => {
    await cli.withProject(testProject())
    const target = await opened()
    using db = openDb(target.paths.sqlite)
    expect(await investigateTickets(cli.services, target, db)).toEqual({
      ok: false,
      error: 'Pick the JIRA project first: `ticketsmith jira discover`.',
    })
  })
})
