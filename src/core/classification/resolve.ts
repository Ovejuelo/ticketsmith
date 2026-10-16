import { type AgentToolServer, askChoice, type OpenedProject } from '../cli/index.ts'
import { err, ok, type Result } from '../kernel/index.ts'
import type { Services } from '../services/index.ts'
import type { Ticket } from '../tickets/index.ts'
import { classifyTicket, confirmWithHuman, saveClassification } from './classify.ts'
import { loadTicketTypes, TICKET_TYPES_FILE } from './load-ticket-types.ts'
import type { Classification } from './ticket-types.schema.ts'

/** Tools for the short classification run: the ticket and the knowledge, nothing else. */
export const CLASSIFY_TOOLS = (name: string): boolean =>
  name === 'jira_get_issue' || name === 'knowledge_search' || name === 'knowledge_read'

/**
 * The full classification of a ticket for a command: rules, then the LLM if they are unsure,
 * then a person if both are (interactive only), saved to out/<KEY>/classification.json.
 */
export const resolveClassification = async (
  services: Services,
  opened: OpenedProject,
  ticket: Ticket,
  options: {
    readonly interactive: boolean
    readonly llm: boolean
    readonly startToolServer: () => Promise<AgentToolServer>
  },
): Promise<
  Result<{ readonly classification: Classification; readonly costUsd: number }, string>
> => {
  const { project, paths } = opened
  const types = await loadTicketTypes(paths.knowledgeDir)
  if (!types.ok) return types
  if (types.value === null) {
    return err(
      `This project has no knowledge/${TICKET_TYPES_FILE} yet: run \`ticketsmith project refresh tickets\` to draft one, or pass --playbook.`,
    )
  }
  const outcome = await classifyTicket(
    ticket,
    types.value,
    {
      agent: services.agent,
      knowledgeDir: paths.knowledgeDir,
      startToolServer: options.startToolServer,
      model: project.agent.model,
      maxBudgetUsd: project.classification.maxBudgetUsd,
      timeoutMs: 5 * 60_000,
    },
    { llm: options.llm },
  )
  if (!outcome.ok) return outcome
  const decided = await confirmWithHuman(ticket.key, outcome.value, types.value, {
    interactive: options.interactive,
    choose: (message, choices, initial) => askChoice(message, choices, initial),
  })
  if (!decided.ok) return decided
  const saved = await saveClassification(paths.outDir, ticket.key, decided.value)
  return saved.ok ? ok({ classification: decided.value, costUsd: outcome.value.costUsd }) : saved
}
