import { describe, expect, it } from 'vitest'
import type { Investigation } from '#src/core/agent/index.ts'
import {
  bySeverity,
  renderInvestigation,
  severityCounts,
} from '#src/features/investigate/render-investigation.ts'

type Finding = Investigation['findings'][number]

const finding = (title: string, severity: Finding['severity']): Finding => ({
  title,
  severity,
  confidence: 'medium',
  evidence: [{ source: 'code', reference: 'api/a.js:1', finding: 'Shows it' }],
  suggestion: 'Fix it',
})

describe('renderInvestigation', () => {
  it('orders findings by severity, keeping the order within one', () => {
    const findings = [
      finding('a', 'low'),
      finding('b', 'high'),
      finding('c', 'info'),
      finding('d', 'high'),
    ]
    expect(bySeverity(findings).map((f) => f.title)).toEqual(['b', 'd', 'a', 'c'])
    expect(severityCounts(findings)).toBe('2 high · 1 low · 1 info')
    expect(severityCounts([])).toBeNull()
  })

  it('quotes the question and says when nothing was found', () => {
    const text = renderInvestigation(
      'review payments\nand refunds',
      { summary: 'Reviewed both flows.', findings: [], nextSteps: [], openQuestions: [] },
      { playbook: 'investigate', generatedAt: '2026-10-20' },
    )
    expect(text).toContain('> review payments\n> and refunds')
    expect(text).toContain('_No findings._')
    expect(text).toContain('## Next steps\n\n_None._')
  })
})
