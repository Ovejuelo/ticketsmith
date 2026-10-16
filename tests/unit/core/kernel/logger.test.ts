import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/core/kernel/logger.ts'

describe('createLogger', () => {
  it('redacts secrets at any known nesting level', () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'info', destination: { write: (l) => lines.push(l) } })

    logger.info(
      { token: 'a', jira: { apiToken: 'b' }, headers: { authorization: 'Basic c' } },
      'request',
    )

    const output = lines.join('')
    expect(output).not.toMatch(/"a"|"b"|Basic c/)
    expect(output).toContain('[REDACTED]')
  })
})
