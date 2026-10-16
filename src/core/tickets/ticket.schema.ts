import { z } from 'zod'

/** Source-agnostic normalized model (JIRA, Linear…). Text in Markdown, dates in ISO 8601 UTC. */

export const TicketKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'Expected format: PROJECT-123')
  .brand<'TicketKey'>()
export type TicketKey = z.infer<typeof TicketKeySchema>

const PersonSchema = z.object({
  id: z.string(),
  displayName: z.string(),
})

export const TicketCommentSchema = z.object({
  id: z.string(),
  author: PersonSchema.nullable(),
  created: z.iso.datetime(),
  body: z.string(),
})

export const TicketAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  created: z.iso.datetime(),
})

export const TicketLinkSchema = z.object({
  type: z.string(),
  key: TicketKeySchema,
  summary: z.string(),
})

export const TicketSummarySchema = z.object({
  key: TicketKeySchema,
  url: z.url(),
  type: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  summary: z.string(),
  assignee: PersonSchema.nullable(),
  updated: z.iso.datetime(),
})

export const TicketSchema = TicketSummarySchema.extend({
  description: z.string(),
  labels: z.array(z.string()).readonly(),
  components: z.array(z.string()).readonly(),
  reporter: PersonSchema.nullable(),
  created: z.iso.datetime(),
  comments: z.array(TicketCommentSchema).readonly(),
  attachments: z.array(TicketAttachmentSchema).readonly(),
  links: z.array(TicketLinkSchema).readonly(),
  /** Only the custom fields mapped in the profile, with readable names and text values. */
  customFields: z.record(z.string(), z.string()).readonly(),
})

export type TicketComment = z.infer<typeof TicketCommentSchema>
export type TicketAttachment = z.infer<typeof TicketAttachmentSchema>
export type TicketSummary = z.infer<typeof TicketSummarySchema>
export type Ticket = Readonly<z.infer<typeof TicketSchema>>
