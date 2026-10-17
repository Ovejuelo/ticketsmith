import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import { AdfNodeSchema } from '../../adf/adf.schema.ts'
import { adfToMarkdown } from '../../adf/adf-to-markdown.ts'
import {
  type Ticket,
  TicketSchema,
  type TicketSummary,
  TicketSummarySchema,
} from '../../ticket.schema.ts'
import type { JiraComment, JiraIssue, JiraSearchIssue } from './jira-api.schemas.ts'

export type NormalizeContext = {
  readonly siteUrl: string
  /** How plain-string rich text is written: Data Center sends wiki markup (default: as is). */
  readonly wikiToMarkdown?: ((wiki: string) => string) | undefined
  /** Readable alias → custom field id. */
  readonly customFields: Readonly<Record<string, string>>
}

export const normalizeIssue = (
  issue: JiraIssue,
  comments: readonly JiraComment[],
  context: NormalizeContext,
): Result<Ticket, string> => {
  const { fields } = issue
  return validate(TicketSchema, {
    ...summaryFields(issue.key, fields, context.siteUrl),
    description: richTextToMarkdown(fields.description, context.wikiToMarkdown),
    labels: fields.labels,
    components: fields.components.map((component) => component.name),
    reporter: person(fields.reporter),
    created: toIsoUtc(fields.created),
    comments: comments.map((comment) => ({
      id: comment.id,
      author: person(comment.author),
      created: toIsoUtc(comment.created),
      body: richTextToMarkdown(comment.body, context.wikiToMarkdown),
    })),
    attachments: fields.attachment.map((attachment) => ({
      ...attachment,
      created: toIsoUtc(attachment.created),
    })),
    links: fields.issuelinks.flatMap((link) => {
      const target = link.outwardIssue ?? link.inwardIssue
      if (target === undefined) return []
      const type = link.outwardIssue ? link.type.outward : link.type.inward
      return [{ type, key: target.key, summary: target.fields?.summary ?? '' }]
    }),
    customFields: Object.fromEntries(
      Object.entries(context.customFields).flatMap(([alias, fieldId]) => {
        const value = flattenFieldValue(fields[fieldId])
        return value === '' ? [] : [[alias, value]]
      }),
    ),
  })
}

export const normalizeSearchIssue = (
  issue: JiraSearchIssue,
  siteUrl: string,
): Result<TicketSummary, string> =>
  validate(TicketSummarySchema, summaryFields(issue.key, issue.fields, siteUrl))

type SummaryFields = JiraSearchIssue['fields']

const summaryFields = (key: string, fields: SummaryFields, siteUrl: string) => ({
  key,
  url: `${siteUrl.replace(/\/+$/, '')}/browse/${key}`,
  type: fields.issuetype.name,
  status: fields.status.name,
  priority: fields.priority?.name ?? null,
  summary: fields.summary,
  assignee: person(fields.assignee),
  updated: toIsoUtc(fields.updated),
})

const validate = <T>(schema: z.ZodType<T>, value: unknown): Result<T, string> => {
  const parsed = schema.safeParse(value)
  return parsed.success ? ok(parsed.data) : err(z.prettifyError(parsed.error))
}

const person = (user: { accountId: string; displayName: string } | null | undefined) =>
  user ? { id: user.accountId, displayName: user.displayName } : null

/** JIRA sends `2026-10-15T10:21:33.123-0500`; normalize to ISO 8601 UTC. */
export const toIsoUtc = (value: string): string => {
  const withColon = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const date = new Date(withColon)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

// API v3 returns ADF; plain strings are wiki markup on Data Center and pass through otherwise.
const richTextToMarkdown = (value: unknown, fromWiki?: (wiki: string) => string): string => {
  if (typeof value === 'string') return fromWiki === undefined ? value : fromWiki(value)
  const adf = AdfNodeSchema.safeParse(value)
  return adf.success ? adfToMarkdown(adf.data) : ''
}

const FieldObjectSchema = z.looseObject({
  value: z.string().optional(),
  displayName: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  child: z.object({ value: z.string() }).optional(),
})

/** Custom field values come in many shapes (option, user, version, ADF, arrays); render as text. */
export const flattenFieldValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map(flattenFieldValue)
      .filter((item) => item !== '')
      .join(', ')
  }
  const parsed = FieldObjectSchema.safeParse(value)
  if (!parsed.success) return JSON.stringify(value)
  const object = parsed.data
  if (object.type === 'doc') return richTextToMarkdown(value)
  if (object.value !== undefined) {
    return object.child ? `${object.value} / ${object.child.value}` : object.value
  }
  return object.displayName ?? object.name ?? JSON.stringify(value)
}
