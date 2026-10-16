import { type ChangeRequest, isExpired } from '../../core/database/index.ts'

const cell = (value: unknown): string =>
  (value === null || value === undefined ? 'NULL' : String(value))
    .replaceAll('|', '\\|')
    .replace(/\s+/g, ' ')

export const effectiveStatus = (change: ChangeRequest, now: Date): string =>
  isExpired(change, now) ? 'expired' : change.status

/** Everything the approver needs, with real values: this is shown only in the local terminal. */
export const renderChange = (change: ChangeRequest, now: Date): string => {
  const sample = change.preflight.sample
  const columns = Object.keys(sample[0] ?? {})
  return [
    `Change ${change.id} · ${effectiveStatus(change, now)}`,
    '',
    `Database:  ${change.database}`,
    `Ticket:    ${change.ticket ?? '-'}`,
    `Reason:    ${change.reason}`,
    `Affects:   ${change.preflight.rows} row(s) of ${change.table} (${change.kind.toUpperCase()})`,
    ...(change.preflight.usesIndex === false
      ? ['Warning:   finding the rows does not use an index']
      : []),
    `Proposed:  ${change.createdAt} · expires ${change.expiresAt}`,
    '',
    'SQL:',
    `  ${change.sql}`,
    ...(sample.length === 0
      ? []
      : [
          '',
          `Current values (${sample.length} of ${change.preflight.rows} rows):`,
          `  | ${columns.join(' | ')} |`,
          ...sample.map((row) => `  | ${columns.map((c) => cell(row[c])).join(' | ')} |`),
        ]),
    '',
    'Rollback:',
    ...(change.rollbackSql ?? '  (written after an INSERT runs, from the new keys)')
      .split('\n')
      .map((line) => `  ${line}`),
    ...(change.decision === undefined
      ? []
      : [
          '',
          `Decided:   ${change.status} by ${change.decision.by} at ${change.decision.at}${change.decision.reason ? ` (${change.decision.reason})` : ''}`,
        ]),
    ...(change.result?.error === undefined ? [] : [`Error:     ${change.result.error}`]),
    '',
  ].join('\n')
}
