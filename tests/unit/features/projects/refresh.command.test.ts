import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '#src/core/kernel/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { sampleOverview } from '#tests/support/jira-overview.ts'

describe('ticketsmith project refresh', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
  })
  afterEach(() => cli.cleanup())

  it('investigates configured integrations and reports them', async () => {
    cli.discovery.overview = ok(sampleOverview)
    expect(await cli.run('project', 'refresh')).toBeNull()
    expect(cli.stderr).toContain('✔ tickets: JIRA project OPS')
    expect(cli.stdout).toBe('Investigated 1 integration(s); the brief was rebuilt.\n')
  })

  it('fails when an investigation fails', async () => {
    cli.discovery.overview = err({ kind: 'forbidden', message: 'no' })
    expect((await cli.run('project', 'refresh', 'tickets'))?.message).toBe(
      'Some investigations failed.',
    )
  })

  it('rejects integrations that are not configured or unknown', async () => {
    await cli.withProject(testProject(null))
    expect((await cli.run('project', 'refresh', 'tickets'))?.message).toMatch(/not configured/)
    expect((await cli.run('project', 'refresh', 'nope'))?.message).toMatch(/invalid/i)
  })
})
