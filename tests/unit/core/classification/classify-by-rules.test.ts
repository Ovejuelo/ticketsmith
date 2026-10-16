import { describe, expect, it } from 'vitest'
import { classifyByRules } from '#src/core/classification/classify-by-rules.ts'
import { parseTicketTypes } from '#src/core/classification/load-ticket-types.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const TYPES = `---
threshold: 0.75
types:
  - name: bug
    description: Something fails
    route: process
    playbook: bug
    match:
      issueTypes: [Incident, Bug]
      keywords: [error, falla, "no carga"]
  - name: service-request
    route: process
    playbook: service-request
    match:
      issueTypes: [Service request]
      labels: [datos]
      keywords: [desactivar, corregir, cambiar]
  - name: new-functionality
    route: feature
    match:
      issueTypes: [New Functionality]
      keywords: [activar, nueva funcionalidad, cobro automático]
---

# Ticket types

Notes for humans.
`

const types = () => {
  const parsed = parseTicketTypes(TYPES)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

describe('classifyByRules', () => {
  it('scores the issue type, labels and keywords and explains the signals', () => {
    const result = classifyByRules(
      makeTicket('OPS-1', {
        type: 'Incident',
        summary: 'Template de notas que no carga',
        description: 'Error 500 al abrir',
      }),
      types(),
    )
    expect(result).toEqual({
      type: 'bug',
      confidence: 0.8,
      reason: 'issue type "Incident"; keywords: error, no carga',
      alternatives: [{ type: 'bug', score: 0.8 }],
    })
  })

  it('ignores case and accents and caps keyword points', () => {
    const result = classifyByRules(
      makeTicket('OPS-2', {
        type: 'Service request',
        labels: ['DATOS'],
        summary: 'Corregir RFC, desactivar cuenta y cambiar correo',
        description: '',
      }),
      types(),
    )
    expect(result?.type).toBe('service-request')
    expect(result?.confidence).toBe(1)
  })

  it('stays under the threshold on the issue type alone, so the LLM decides', () => {
    // On some boards "Service request" also holds new functionality.
    const result = classifyByRules(
      makeTicket('OPS-3', {
        type: 'Service request',
        summary: 'Activar tarjetas guardadas y cobro automático',
        description: '',
      }),
      types(),
    )
    expect(result).toMatchObject({ type: 'service-request', confidence: 0.6 })
    expect(result?.alternatives).toEqual([
      { type: 'service-request', score: 0.6 },
      { type: 'new-functionality', score: 0.2 },
    ])
  })

  it('lowers the confidence when two types are close', () => {
    const result = classifyByRules(
      makeTicket('OPS-5', { type: 'Task', summary: 'Error al activar la opción', description: '' }),
      types(),
    )
    expect(result?.confidence).toBe(0.08)
    expect(result?.reason).toMatch(/close to/)
  })

  it('returns null when nothing matches', () => {
    expect(
      classifyByRules(
        makeTicket('OPS-4', { type: 'Task', summary: 'Hola', description: '' }),
        types(),
      ),
    ).toBeNull()
  })
})

describe('parseTicketTypes', () => {
  it('reads the front matter with defaults', () => {
    expect(types().threshold).toBe(0.75)
    expect(types().types[2]).toMatchObject({
      name: 'new-functionality',
      route: 'feature',
      description: '',
    })
  })

  it.each([
    ['no front matter', '# Ticket types', /front matter/],
    [
      'duplicate names',
      '---\ntypes:\n  - { name: bug, playbook: bug }\n  - { name: bug, playbook: bug }\n---\n',
      /Duplicate type "bug"/,
    ],
    ['process without playbook', '---\ntypes:\n  - { name: bug }\n---\n', /playbook/],
    ['bad yaml', '---\ntypes: [\n---\n', /YAML/],
    [
      'bad threshold',
      '---\nthreshold: 2\ntypes:\n  - { name: bug, playbook: bug }\n---\n',
      /threshold/,
    ],
  ])('rejects %s', (_, text, message) => {
    const parsed = parseTicketTypes(text)
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.error).toMatch(message)
  })
})
