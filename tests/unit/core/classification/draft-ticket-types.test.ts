import { describe, expect, it } from 'vitest'
import { draftTicketTypes, parseTicketTypes } from '#src/core/classification/index.ts'

describe('draftTicketTypes', () => {
  it('maps issue types by name and lists the ones it cannot map', () => {
    const draft = draftTicketTypes([
      'Service request',
      'Incident',
      'New Functionality - Process Improvement',
      'Payments Ops',
    ])
    const parsed = parseTicketTypes(draft)
    if (!parsed.ok) throw new Error(parsed.error)
    const issueTypes = Object.fromEntries(
      parsed.value.types.map((type) => [type.name, type.match.issueTypes]),
    )
    expect(issueTypes).toEqual({
      bug: ['Incident'],
      'service-request': ['Service request'],
      'new-functionality': ['New Functionality - Process Improvement'],
      report: [],
    })
    expect(draft).toContain('Issue types not mapped yet: Payments Ops.')
    expect(draft).toContain('**review it**')
  })
})
