import type { AuditEntry, AuditLog } from '#src/core/audit/index.ts'

export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = []

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}
