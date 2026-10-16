import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { draftTicketTypes, TICKET_TYPES_FILE } from '../../core/classification/index.ts'
import { type OpenedProject, requireTickets } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { writeKnowledge } from '../../core/knowledge/index.ts'
import type { Services } from '../../core/services/index.ts'
import type { ProjectDatabase } from '../../core/storage/index.ts'
import {
  describeTicketSourceError,
  type JiraFieldInfo,
  type JiraProjectOverview,
  type TicketSummary,
} from '../../core/tickets/index.ts'

export const TICKETS_KNOWLEDGE_FILE = 'tickets/jira.md'
const EXAMPLES_PER_TYPE = 3

export type InvestigationOutcome = { readonly summary: string }

/**
 * Studies the project's JIRA (issue types and their workflows, components, custom fields and
 * recent examples per type), stores the facts in the local catalog and writes a masked
 * knowledge file for the agent.
 */
export const investigateTickets = async (
  services: Services,
  opened: OpenedProject,
  db: ProjectDatabase,
): Promise<Result<InvestigationOutcome, string>> => {
  const tickets = await requireTickets(services, opened)
  const { config } = tickets
  if (tickets.discovery === null) return err('This ticket source cannot be investigated yet.')
  if (config.projectKey === undefined) {
    return err('Pick the JIRA project first: `ticketsmith jira discover`.')
  }

  const overview = await tickets.discovery.getProjectOverview(config.projectKey)
  if (!overview.ok) return err(describeTicketSourceError(overview.error))
  const fields = await tickets.discovery.listCustomFields()
  if (!fields.ok) return err(describeTicketSourceError(fields.error))

  const examples = new Map<string, readonly TicketSummary[]>()
  for (const type of overview.value.issueTypes.filter((issueType) => !issueType.subtask)) {
    const page = await tickets.source.search({
      query: `project = "${overview.value.key}" AND issuetype = "${type.name}" ORDER BY updated DESC`,
      limit: EXAMPLES_PER_TYPE,
    })
    if (!page.ok) return err(describeTicketSourceError(page.error))
    examples.set(type.name, page.value.tickets)
  }

  const aliasById = new Map(Object.entries(config.customFields).map(([alias, id]) => [id, alias]))
  db.replaceCatalog('tickets', 'project', [
    {
      key: overview.value.key,
      data: {
        name: overview.value.name,
        description: overview.value.description,
        siteUrl: config.siteUrl,
      },
    },
  ])
  db.replaceCatalog(
    'tickets',
    'issue-type',
    overview.value.issueTypes.map((type) => ({
      key: type.name,
      data: {
        ...type,
        examples: (examples.get(type.name) ?? []).map(({ key, summary, status }) => ({
          key,
          summary,
          status,
        })),
      },
    })),
  )
  db.replaceCatalog(
    'tickets',
    'component',
    overview.value.components.map((component) => ({ key: component.name, data: component })),
  )
  db.replaceCatalog(
    'tickets',
    'custom-field',
    fields.value.map((field) => ({
      key: field.id,
      data: { name: field.name, alias: aliasById.get(field.id) ?? null },
    })),
  )

  const markdown = renderJiraKnowledge(overview.value, examples, fields.value, aliasById, {
    siteUrl: config.siteUrl,
    jql: config.jql,
  })
  const written = await writeKnowledge(
    opened.paths.knowledgeDir,
    TICKETS_KNOWLEDGE_FILE,
    markdown,
    opened.project.masking,
  )
  if (!written.ok) return err(written.error.message)

  const types = overview.value.issueTypes
    .filter((type) => !type.subtask)
    .map((type) => type.name.trim())
  // A first ticket-types.md for classification; never overwrites the team's own.
  if (!existsSync(join(opened.paths.knowledgeDir, TICKET_TYPES_FILE))) {
    const drafted = await writeKnowledge(
      opened.paths.knowledgeDir,
      TICKET_TYPES_FILE,
      draftTicketTypes(types),
      opened.project.masking,
    )
    if (!drafted.ok) return err(drafted.error.message)
  }
  return ok({
    summary: `JIRA project ${overview.value.key} (${overview.value.name}): ${types.length} issue types (${types.join(', ')})`,
  })
}

const CATEGORY_ORDER = ['To Do', 'In Progress', 'Done']

/** JIRA does not expose the workflow order without admin rights, so group by status category. */
const groupStatuses = (
  statuses: readonly { readonly name: string; readonly category: string }[],
): string => {
  const byCategory = new Map<string, string[]>()
  for (const status of statuses) {
    const category = status.category || 'Other'
    byCategory.set(category, [...(byCategory.get(category) ?? []), status.name])
  }
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category)
    return index === -1 ? CATEGORY_ORDER.length : index
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([category, names]) => `${category}: ${names.join(', ')}`)
    .join(' · ')
}

export const renderJiraKnowledge = (
  overview: JiraProjectOverview,
  examples: ReadonlyMap<string, readonly TicketSummary[]>,
  fields: readonly JiraFieldInfo[],
  aliasById: ReadonlyMap<string, string>,
  context: { readonly siteUrl: string; readonly jql: string | undefined },
): string => {
  const mapped = fields.filter((field) => aliasById.has(field.id))
  const issueTypes = overview.issueTypes.map((type) => {
    const statuses = groupStatuses(type.statuses) || '_unknown_'
    const typeExamples = examples.get(type.name) ?? []
    return [
      `### ${type.name.trim()}${type.subtask ? ' (sub-task)' : ''}`,
      '',
      type.description || '_No description in JIRA._',
      '',
      `- **Statuses:** ${statuses}`,
      ...(typeExamples.length > 0
        ? [
            '- **Recent examples:**',
            ...typeExamples.map((t) => `  - ${t.key} · ${t.status} · ${t.summary.trim()}`),
          ]
        : []),
    ].join('\n')
  })

  return [
    `# JIRA: ${overview.key} · ${overview.name}`,
    '',
    `- **Site:** ${context.siteUrl}`,
    `- **JQL used by \`ticketsmith list\`:** ${context.jql ? `\`${context.jql}\`` : '_not set_'}`,
    ...(overview.description ? ['', overview.description] : []),
    '',
    '## Issue types',
    '',
    issueTypes.join('\n\n'),
    '',
    '## Components',
    '',
    overview.components.length > 0
      ? overview.components
          .map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`)
          .join('\n')
      : '_None._',
    '',
    '## Custom fields',
    '',
    mapped.length > 0
      ? mapped
          .map((field) => `- \`${aliasById.get(field.id)}\` = ${field.name} (${field.id})`)
          .join('\n')
      : '_None mapped._',
    '',
    `${fields.length} custom fields exist in this site; map the useful ones with \`ticketsmith jira discover --fields\`.`,
    '',
  ].join('\n')
}
