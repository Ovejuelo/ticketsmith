/** One audited action. Outputs are summarized (size and masking counts), never stored. */
export type AuditEntry = {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly ok: boolean
  readonly error?: string
  readonly durationMs: number
  readonly output?: {
    readonly chars: number
    readonly masked: Readonly<Record<string, number>>
  }
}

export interface AuditLog {
  /** Never throws: auditing problems must not break the audited action. */
  record(entry: AuditEntry): Promise<void>
}
