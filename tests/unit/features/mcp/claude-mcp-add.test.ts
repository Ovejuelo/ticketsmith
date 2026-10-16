import { describe, expect, it } from 'vitest'
import { mcpAddCommand } from '#src/features/mcp/claude-mcp-add.ts'

describe('mcpAddCommand', () => {
  it('pins the project when one is given and quotes unusual paths', () => {
    expect(
      mcpAddCommand({ execPath: '/usr/bin/node', scriptPath: "/My Apps/it's/main.js" }, 'acme'),
    ).toBe(
      "claude mcp add --scope user ticketsmith -- /usr/bin/node '/My Apps/it'\\''s/main.js' --project acme mcp",
    )
  })
})
