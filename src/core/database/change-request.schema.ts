import { z } from 'zod'

export const ChangeIdSchema = z
  .string()
  .regex(/^cr-[0-9a-f]{8}$/, 'A change id looks like cr-1a2b3c4d')

export const ChangeStatusSchema = z.enum(['proposed', 'rejected', 'executed', 'failed'])
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>

/**
 * A proposed database change, stored as local/changes/<id>.json (owner-only): it holds the real
 * SQL and values, so it never leaves the machine and never reaches the agent unmasked.
 */
export const ChangeRequestSchema = z.object({
  id: ChangeIdSchema,
  database: z.string(),
  ticket: z.string().nullable(),
  reason: z.string(),
  /** The regenerated SQL, with real values. */
  sql: z.string(),
  kind: z.enum(['insert', 'update']),
  table: z.string(),
  preflight: z.object({
    rows: z.number().int(),
    sample: z.array(z.record(z.string(), z.unknown())),
    usesIndex: z.boolean().nullable(),
  }),
  rollbackSql: z.string().nullable(),
  status: ChangeStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  decision: z
    .object({
      at: z.string(),
      by: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  result: z
    .object({
      affectedRows: z.number().int().optional(),
      insertId: z.number().int().nullable().optional(),
      error: z.string().optional(),
    })
    .optional(),
})
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>

export const CHANGE_TTL_MS = 60 * 60 * 1000

export const isExpired = (change: ChangeRequest, now: Date): boolean =>
  change.status === 'proposed' && new Date(change.expiresAt).getTime() <= now.getTime()
