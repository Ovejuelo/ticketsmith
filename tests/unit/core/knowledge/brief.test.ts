import { describe, expect, it } from 'vitest'
import { renderBrief } from '#src/core/knowledge/brief.ts'

describe('renderBrief', () => {
  it('links every investigated area', () => {
    const brief = renderBrief({
      project: 'billing',
      integrations: ['tickets'],
      sections: [{ title: 'JIRA', file: 'tickets/jira.md', summary: 'OPS with 4 issue types' }],
      generatedAt: '2026-10-15',
    })
    expect(brief).toContain('# Project brief: billing')
    expect(brief).toContain('- tickets')
    expect(brief).toContain('- **[JIRA](tickets/jira.md)**: OPS with 4 issue types')
  })

  it('guides when nothing is configured yet', () => {
    const brief = renderBrief({ project: 'x', integrations: [], sections: [], generatedAt: 'now' })
    expect(brief).toContain('None yet. Add one with `ticketsmith project add <integration>`.')
    expect(brief).toContain('Nothing investigated yet.')
  })
})
