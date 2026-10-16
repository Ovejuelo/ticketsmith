import { stringify } from 'yaml'

type Draft = {
  readonly name: string
  readonly description: string
  readonly route: 'process' | 'code' | 'feature'
  readonly playbook?: string
  readonly pattern: RegExp
  readonly keywords: readonly string[]
}

// Generic starting points (English and Spanish); every project edits them.
const DRAFTS: readonly Draft[] = [
  {
    name: 'bug',
    description: 'Something that worked, or should work, fails',
    route: 'process',
    playbook: 'bug',
    pattern: /bug|incident|incidente|defect|defecto|error|falla|problem/i,
    keywords: ['error', 'falla', 'no funciona', 'no carga', 'not working', 'broken'],
  },
  {
    name: 'service-request',
    description: 'A change to data or configuration that a person requests (no code)',
    route: 'process',
    playbook: 'service-request',
    pattern: /service|servicio|request|solicitud|support|soporte|task|tarea/i,
    keywords: [
      'desactivar',
      'activar cuenta',
      'corregir',
      'cambiar',
      'actualizar datos',
      'deactivate',
      'update',
    ],
  },
  {
    name: 'new-functionality',
    description: 'Something the product does not do yet',
    route: 'feature',
    pattern: /feature|functionality|funcionalidad|improvement|mejora|story|historia|epic|new/i,
    keywords: ['nueva funcionalidad', 'agregar', 'permitir', 'new feature', 'add support'],
  },
  {
    name: 'report',
    description: 'A data report or query, usually for Metabase',
    route: 'process',
    playbook: 'report',
    pattern: /report|reporte|metabase|query|consulta/i,
    keywords: ['reporte', 'metabase', 'report', 'exportar', 'export'],
  },
]

/**
 * A first knowledge/ticket-types.md from the issue types the ticket source has: each issue type
 * goes to the generic type its name suggests; the rest are listed for a person to map.
 */
export const draftTicketTypes = (issueTypes: readonly string[]): string => {
  const assigned = new Map<string, string[]>()
  const unmapped: string[] = []
  for (const issueType of issueTypes) {
    const draft = DRAFTS.find((candidate) => candidate.pattern.test(issueType))
    if (draft === undefined) unmapped.push(issueType)
    else assigned.set(draft.name, [...(assigned.get(draft.name) ?? []), issueType])
  }
  const front = {
    threshold: 0.75,
    types: DRAFTS.map((draft) => ({
      name: draft.name,
      description: draft.description,
      route: draft.route,
      ...(draft.playbook === undefined ? {} : { playbook: draft.playbook }),
      match: {
        issueTypes: assigned.get(draft.name) ?? [],
        labels: [],
        components: [],
        keywords: [...draft.keywords],
      },
    })),
  }
  return [
    '---',
    stringify(front).trimEnd(),
    '---',
    '',
    '# Ticket types',
    '',
    'Drafted by Ticketsmith from the issue types of the ticket source: **review it**. Rules score each type (issue type 0.6, each label or component 0.25, keywords up to 0.3); under `threshold` the LLM decides, and a person when it is unsure too.',
    '',
    "- `route: process` runs the type's playbook (`ticketsmith process`); `code` and `feature` change code, which a person always starts (`ticketsmith code` / `ticketsmith feature`).",
    '- Add labels, components and keywords your team really uses; remove the ones that mislead.',
    ...(unmapped.length > 0 ? ['', `Issue types not mapped yet: ${unmapped.join(', ')}.`] : []),
    '',
  ].join('\n')
}
