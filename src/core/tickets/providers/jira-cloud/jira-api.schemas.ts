import { z } from 'zod'

// Only the fields Ticketsmith reads. Unknown fields are stripped, so API additions never break us.

export const JiraUserSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
})

export const JiraMyselfSchema = JiraUserSchema.extend({
  emailAddress: z.string().optional(),
})

const NamedSchema = z.object({ name: z.string() })

const LinkedIssueSchema = z.object({
  key: z.string(),
  fields: z.object({ summary: z.string() }).optional(),
})

export const JiraIssueFieldsSchema = z
  .object({
    summary: z.string(),
    issuetype: NamedSchema,
    status: NamedSchema,
    priority: NamedSchema.nullish(),
    description: z.unknown(),
    labels: z.array(z.string()).default([]),
    components: z.array(NamedSchema).default([]),
    reporter: JiraUserSchema.nullish(),
    assignee: JiraUserSchema.nullish(),
    created: z.string(),
    updated: z.string(),
    attachment: z
      .array(
        z.object({
          id: z.string(),
          filename: z.string(),
          mimeType: z.string(),
          size: z.number(),
          created: z.string(),
        }),
      )
      .default([]),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ inward: z.string(), outward: z.string() }),
          inwardIssue: LinkedIssueSchema.optional(),
          outwardIssue: LinkedIssueSchema.optional(),
        }),
      )
      .default([]),
  })
  // Custom fields (customfield_*) have arbitrary shapes; keep them as unknown.
  .catchall(z.unknown())

export const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: JiraIssueFieldsSchema,
})
export type JiraIssue = z.infer<typeof JiraIssueSchema>

export const JiraCommentSchema = z.object({
  id: z.string(),
  author: JiraUserSchema.nullish(),
  body: z.unknown(),
  created: z.string(),
})
export type JiraComment = z.infer<typeof JiraCommentSchema>

export const JiraCommentPageSchema = z.object({
  startAt: z.number(),
  total: z.number(),
  comments: z.array(JiraCommentSchema),
})

export const JiraSearchIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    issuetype: NamedSchema,
    status: NamedSchema,
    priority: NamedSchema.nullish(),
    assignee: JiraUserSchema.nullish(),
    updated: z.string(),
  }),
})
export type JiraSearchIssue = z.infer<typeof JiraSearchIssueSchema>

export const JiraSearchPageSchema = z.object({
  issues: z.array(JiraSearchIssueSchema),
  nextPageToken: z.string().nullish(),
})

export const JiraProjectPageSchema = z.object({
  values: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
  isLast: z.boolean().default(true),
})

export const JiraBoardSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  location: z.object({ projectKey: z.string().optional() }).optional(),
})
export type JiraBoard = z.infer<typeof JiraBoardSchema>

export const JiraBoardPageSchema = z.object({
  values: z.array(JiraBoardSchema),
  isLast: z.boolean().default(true),
})

export const JiraBoardConfigurationSchema = z.object({
  filter: z.object({ id: z.string() }),
})

export const JiraFilterSchema = z.object({ jql: z.string() })

export const JiraFieldListSchema = z.array(
  z.object({ id: z.string(), name: z.string(), custom: z.boolean().default(false) }),
)

export const JiraProjectDetailSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  issueTypes: z
    .array(
      z.object({
        name: z.string(),
        subtask: z.boolean().default(false),
        description: z.string().nullish(),
      }),
    )
    .default([]),
})

export const JiraProjectStatusesSchema = z.array(
  z.object({
    name: z.string(),
    statuses: z.array(
      z.object({
        name: z.string(),
        statusCategory: z.object({ name: z.string() }).optional(),
      }),
    ),
  }),
)

export const JiraComponentListSchema = z.array(
  z.object({ name: z.string(), description: z.string().nullish() }),
)

export const TenantInfoSchema = z.object({ cloudId: z.string().min(1) })
