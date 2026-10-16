import type { TicketSummary } from '../../core/tickets/index.ts'

type Column = {
  readonly header: string
  readonly value: (ticket: TicketSummary) => string
  readonly max: number
}

const COLUMNS: readonly Column[] = [
  { header: 'KEY', value: (t) => t.key, max: 14 },
  { header: 'TYPE', value: (t) => t.type, max: 18 },
  { header: 'STATUS', value: (t) => t.status, max: 22 },
  { header: 'PRIORITY', value: (t) => t.priority ?? '-', max: 10 },
  { header: 'ASSIGNEE', value: (t) => t.assignee?.displayName ?? '-', max: 18 },
]
const SUMMARY_MIN = 20
const GAP = '  '

const truncate = (text: string, width: number): string =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(width - 1, 0))}…`

/** Plain-text table that fits the terminal width; the summary takes the remaining space. */
export const formatTicketTable = (tickets: readonly TicketSummary[], columns: number): string => {
  const widths = COLUMNS.map((column) =>
    Math.min(
      column.max,
      Math.max(column.header.length, ...tickets.map((t) => column.value(t).length)),
    ),
  )
  const used = widths.reduce((sum, width) => sum + width + GAP.length, 0)
  const summaryWidth = Math.max(SUMMARY_MIN, columns - used)

  const row = (cells: readonly string[], summary: string) =>
    [
      ...cells.map((cell, i) => truncate(cell, widths[i] ?? cell.length)),
      truncate(summary, summaryWidth),
    ]
      .join(GAP)
      .trimEnd()

  return [
    row(
      COLUMNS.map((column) => column.header),
      'SUMMARY',
    ),
    ...tickets.map((ticket) =>
      row(
        COLUMNS.map((column) => column.value(ticket)),
        ticket.summary,
      ),
    ),
  ].join('\n')
}
