import { describe, expect, it } from 'vitest'
import { TicketKeySchema } from '#src/core/tickets/ticket.schema.ts'

describe('TicketKeySchema', () => {
  it.each(['PROJ-1', 'AB2-123', 'MY_PROJ-9'])('accepts %s', (key) => {
    expect(TicketKeySchema.safeParse(key).success).toBe(true)
  })

  it.each(['proj-1', 'PROJ', 'PROJ-', '-1', 'PROJ-1a', '1PROJ-1'])('rejects %s', (key) => {
    expect(TicketKeySchema.safeParse(key).success).toBe(false)
  })
})
