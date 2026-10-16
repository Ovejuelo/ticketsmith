import { describe, expect, it } from 'vitest'
import { FakeCli } from '#tests/support/fake-cli.ts'

describe('ticketsmith mcp setup', () => {
  it('prints the claude mcp add command with absolute paths', async () => {
    const cli = await FakeCli.create()
    await cli.run('mcp', 'setup')
    expect(cli.stdout).toContain(
      'claude mcp add --scope user ticketsmith -- /usr/local/bin/node /opt/ticketsmith/dist/main.js mcp',
    )
    await cli.cleanup()
  })
})
