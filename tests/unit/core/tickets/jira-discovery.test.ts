import { describe, expect, it } from 'vitest'
import { defaultProjectJql, deriveOpenTicketsJql } from '#src/core/tickets/jira-discovery.ts'

describe('JQL helpers', () => {
  it('builds the default project JQL', () => {
    expect(defaultProjectJql('OPS')).toBe(
      'project = "OPS" AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    )
  })

  it('wraps a board filter, replacing its ordering', () => {
    expect(deriveOpenTicketsJql('project = OPS AND type = Bug\nORDER BY Rank ASC')).toBe(
      '(project = OPS AND type = Bug) AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    )
  })
})
