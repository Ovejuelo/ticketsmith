import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  describeAgentError,
  loadPlaybook,
  runStructured,
  type TicketAnalysis,
  TicketAnalysisSchema,
} from '../../core/agent/index.ts'
import type { AgentToolServer, ConnectedTickets, OpenedProject } from '../../core/cli/index.ts'
import { ChangeStore } from '../../core/database/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../../core/output/index.ts'
import { configuredIntegrations } from '../../core/project/index.ts'
import type { Services } from '../../core/services/index.ts'
import {
  describeTicketSourceError,
  renderTicketMarkdown,
  type TicketKey,
} from '../../core/tickets/index.ts'
import { renderAnalysis, revealDeep } from './render-analysis.ts'

export const ANALYSIS_FILE = 'analysis.md'

export type ProcessOptions = {
  readonly playbook: string
  readonly model?: string | undefined
  readonly budgetUsd?: number | undefined
}

/** What `run.json` records: how the run went, never what the agent saw. */
export type RunRecord = {
  readonly ticket: string
  readonly playbook: { readonly name: string; readonly source: 'project' | 'built-in' }
  readonly model: string | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly costUsd: number
  readonly turns: number
  readonly attempts: number
  readonly sessionIds: readonly string[]
  readonly toolCalls: Readonly<Record<string, number>>
  readonly confidence: TicketAnalysis['confidence']
  /** Database changes the agent proposed in this run, waiting for `ticketsmith changes approve`. */
  readonly changeRequests: readonly string[]
  readonly files: readonly string[]
}

export type ProcessedTicket = {
  readonly analysis: TicketAnalysis
  readonly record: RunRecord
  readonly dir: string
}

/** The prompt carries only the ticket key and what the project offers; data comes from tools. */
export const ticketPrompt = (key: string, opened: OpenedProject): string => {
  const integrations = configuredIntegrations(opened.project)
  return [
    `Investigate ticket ${key} of the project "${opened.project.name}".`,
    'Start with knowledge_read("brief.md"), then read the ticket with jira_get_issue.',
    `This project has: ${integrations.join(', ')}. Use only the tools you have; there is no other access.`,
    'Follow the playbook in your instructions and finish with the required JSON answer.',
  ].join('\n')
}

/**
 * Investigates one ticket with the agent and writes out/<KEY>/: ticket.md and ticket.json (as the
 * source has them), analysis.md and jira_comment.md (the agent's answer with real values put back
 * locally; secrets stay masked) and run.json. The agent itself only ever sees masked tool output.
 */
export const processTicket = async (
  services: Services,
  opened: OpenedProject,
  tickets: ConnectedTickets,
  key: TicketKey,
  options: ProcessOptions,
  startToolServer: () => Promise<AgentToolServer>,
): Promise<Result<ProcessedTicket, string>> => {
  const { project, paths } = opened
  const ticket = await tickets.source.getTicket(key)
  if (!ticket.ok) return err(describeTicketSourceError(ticket.error))
  const playbook = await loadPlaybook(paths.knowledgeDir, options.playbook)
  if (!playbook.ok) return playbook

  const model = options.model ?? project.agent.model
  const startedAt = new Date()
  const server = await startToolServer()
  try {
    const result = await runStructured(
      services.agent,
      {
        prompt: ticketPrompt(key, opened),
        playbook: playbook.value.text,
        mcpConfig: server.mcpConfig,
        model,
        maxBudgetUsd: options.budgetUsd ?? project.agent.maxBudgetUsd,
        timeoutMs: project.agent.timeoutMinutes * 60_000,
      },
      TicketAnalysisSchema,
    )
    const durationMs = Date.now() - startedAt.getTime()
    await server.record({
      tool: 'agent_run',
      input: { ticket: key, playbook: playbook.value.name, model: model ?? 'default' },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs,
    })
    if (!result.ok) return err(describeAgentError(result.error))

    const analysis = revealDeep(result.value.value, server.reveal)
    const dir = ticketOutputDir(paths.outDir, ticket.value.key)
    const finishedAt = new Date()
    const record: RunRecord = {
      ticket: ticket.value.key,
      playbook: { name: playbook.value.name, source: playbook.value.source },
      model: model ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      costUsd: result.value.runs.reduce((sum, run) => sum + run.costUsd, 0),
      turns: result.value.runs.reduce((sum, run) => sum + run.turns, 0),
      attempts: result.value.runs.length,
      sessionIds: result.value.runs.map((run) => run.sessionId),
      toolCalls: server.toolCalls(),
      confidence: analysis.confidence,
      changeRequests: (await new ChangeStore(paths.changesDir).list())
        .filter(
          (change) =>
            change.ticket === ticket.value.key && change.createdAt >= startedAt.toISOString(),
        )
        .map((change) => change.id),
      files: ['ticket.md', 'ticket.json', ANALYSIS_FILE, 'jira_comment.md', 'run.json'],
    }
    const written = await writeOutputFiles(dir, {
      'ticket.md': renderTicketMarkdown(ticket.value),
      'ticket.json': `${JSON.stringify(ticket.value, null, 2)}\n`,
      [ANALYSIS_FILE]: renderAnalysis(ticket.value.key, analysis, {
        playbook: playbook.value.name,
        generatedAt: finishedAt.toISOString().slice(0, 10),
      }),
      'jira_comment.md': `${analysis.jiraComment.trim()}\n`,
      'run.json': `${JSON.stringify(record, null, 2)}\n`,
    })
    if (!written.ok) return err(describeOutputError(written.error))
    return ok({ analysis, record, dir })
  } finally {
    await server.close()
  }
}

/** The first ticket of the project's JQL that has no analysis yet. */
export const nextUnprocessed = async (
  tickets: ConnectedTickets,
  jql: string,
  outDir: string,
): Promise<Result<TicketKey | null, string>> => {
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await tickets.source.search({
      query: jql,
      limit: 50,
      ...(pageToken === undefined ? {} : { pageToken }),
    })
    if (!result.ok) return err(describeTicketSourceError(result.error))
    const next = result.value.tickets.find(
      (ticket) => !existsSync(join(ticketOutputDir(outDir, ticket.key), ANALYSIS_FILE)),
    )
    if (next !== undefined) return ok(next.key)
    if (result.value.nextPageToken === null) return ok(null)
    pageToken = result.value.nextPageToken
  }
  return ok(null)
}
