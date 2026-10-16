import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli } from '#tests/support/fake-cli.ts'

describe('ticketsmith program', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('prints the version', async () => {
    await cli.run('--version')
    expect(cli.stdout.trim()).toBe('1.2.3')
  })

  it('lists every command in the help', async () => {
    await cli.run('--help')
    for (const command of ['project', 'doctor', 'jira', 'list', 'show', 'mcp']) {
      expect(cli.stdout).toContain(command)
    }
  })
})
