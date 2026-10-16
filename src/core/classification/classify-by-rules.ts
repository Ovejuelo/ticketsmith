import type { Ticket } from '../tickets/index.ts'
import type { TicketType, TicketTypes } from './ticket-types.schema.ts'

const ISSUE_TYPE_POINTS = 0.6
const LABEL_POINTS = 0.25
const KEYWORD_POINTS = 0.1
const MAX_KEYWORD_POINTS = 0.3
/** Two types closer than this make the best one ambiguous. */
const CLOSE = 0.15
const AMBIGUITY_FACTOR = 0.8

export type RuleResult = {
  readonly type: string
  readonly confidence: number
  readonly reason: string
  readonly alternatives: readonly { readonly type: string; readonly score: number }[]
}

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

const round = (value: number): number => Math.round(value * 100) / 100

const score = (ticket: Ticket, type: TicketType): { score: number; signals: string[] } => {
  const signals: string[] = []
  let points = 0
  const issueType = normalize(ticket.type)
  if (type.match.issueTypes.some((name) => normalize(name) === issueType)) {
    points += ISSUE_TYPE_POINTS
    signals.push(`issue type "${ticket.type}"`)
  }
  const labels = new Set(ticket.labels.map(normalize))
  const components = new Set(ticket.components.map(normalize))
  for (const label of type.match.labels.filter((l) => labels.has(normalize(l)))) {
    points += LABEL_POINTS
    signals.push(`label "${label}"`)
  }
  for (const component of type.match.components.filter((c) => components.has(normalize(c)))) {
    points += LABEL_POINTS
    signals.push(`component "${component}"`)
  }
  const text = normalize(`${ticket.summary}\n${ticket.description}`)
  const keywords = type.match.keywords.filter((keyword) => text.includes(normalize(keyword)))
  if (keywords.length > 0) {
    points += Math.min(keywords.length * KEYWORD_POINTS, MAX_KEYWORD_POINTS)
    signals.push(`keywords: ${keywords.join(', ')}`)
  }
  return { score: round(Math.min(points, 1)), signals }
}

/**
 * Classifies a ticket from the signals in ticket-types.md: issue type, labels, components and
 * keywords (case and accents ignored). Free and deterministic; the LLM only steps in when this
 * stays under the threshold. Null when no type matches at all.
 */
export const classifyByRules = (ticket: Ticket, types: TicketTypes): RuleResult | null => {
  const scored = types.types
    .map((type) => ({ type: type.name, ...score(ticket, type) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  const [best, second] = scored
  if (best === undefined) return null
  const close = second !== undefined && best.score - second.score < CLOSE
  return {
    type: best.type,
    confidence: close ? round(best.score * AMBIGUITY_FACTOR) : best.score,
    reason: [...best.signals, ...(close ? [`close to ${second.type} (${second.score})`] : [])].join(
      '; ',
    ),
    alternatives: scored.map(({ type, score: points }) => ({ type, score: points })),
  }
}
