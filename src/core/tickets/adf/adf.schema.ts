import { z } from 'zod'

/**
 * Tolerant model of Atlassian Document Format: only the structural fields are typed so that
 * new or unknown node types still parse and can degrade to text.
 */
export type AdfMark = {
  readonly type: string
  readonly attrs?: Readonly<Record<string, unknown>> | undefined
}

export type AdfNode = {
  readonly type: string
  readonly text?: string | undefined
  readonly attrs?: Readonly<Record<string, unknown>> | undefined
  readonly marks?: readonly AdfMark[] | undefined
  readonly content?: readonly AdfNode[] | undefined
}

const AdfMarkSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
})

export const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(AdfMarkSchema).optional(),
    content: z.array(AdfNodeSchema).optional(),
  }),
)
