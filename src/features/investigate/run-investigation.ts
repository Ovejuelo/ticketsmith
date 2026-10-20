import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  describeAgentError,
  type Investigation,
  InvestigationSchema,
  loadPlaybook,
  runStructured,
} from '../../core/agent/index.ts'
import type { AgentToolServer, OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { describeOutputError, writeOutputFiles } from '../../core/output/index.ts'
import { configuredIntegrations } from '../../core/project/index.ts'
import { revealDeep } from '../../core/security/index.ts'
import type { Services } from '../../core/services/index.ts'
import { renderInvestigation } from './render-investigation.ts'

export const INVESTIGATIONS_DIR = 'investigations'

/** Investigations only read: no code sessions and no proposed database changes. */
export const INVESTIGATE_TOOLS = (name: string): boolean =>
  !name.startsWith('code_') && name !== 'db_propose_change'

export type InvestigateOptions = {
  readonly playbook: string
  readonly model?: string | undefined
  readonly budgetUsd?: number | undefined
}

/** What `run.json` records: how the run went, never what the agent saw. */
export type InvestigationRecord = {
  readonly investigation: string
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
  readonly findings: number
  readonly files: readonly string[]
}

export type CompletedInvestigation = {
  readonly investigation: Investigation
  readonly record: InvestigationRecord
  readonly dir: string
}

/** A folder-safe slug: lowercase ASCII words, accents dropped, at most 48 characters. */
export const slugify = (text: string): string => {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug === '' ? 'investigation' : slug
}

/** out/investigations/<date>-<slug>, with -2, -3… when a run of the same day already used it. */
export const investigationDir = (outDir: string, date: string, slug: string): string => {
  const base = join(outDir, INVESTIGATIONS_DIR, `${date}-${slug}`)
  let dir = base
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`
  return dir
}

/** The prompt carries the question already masked; data comes from tools. */
export const investigationPrompt = (maskedQuestion: string, opened: OpenedProject): string => {
  const integrations = configuredIntegrations(opened.project)
  return [
    `Investigate this question about the project "${opened.project.name}". There is no ticket.`,
    'Start with knowledge_read("brief.md").',
    `This project has: ${integrations.join(', ')}. Use only the tools you have; there is no other access.`,
    'Follow the playbook in your instructions and finish with the required JSON answer.',
    '',
    'Question:',
    maskedQuestion,
  ].join('\n')
}

/**
 * Investigates a free-form question with the agent and writes out/investigations/<date>-<slug>/:
 * question.md (as asked), analysis.md (the agent's answer with real values put back locally;
 * secrets stay masked) and run.json. The agent only ever sees the masked question and masked tool
 * output.
 */
export const runInvestigation = async (
  services: Services,
  opened: OpenedProject,
  question: string,
  options: InvestigateOptions,
  startToolServer: () => Promise<AgentToolServer>,
): Promise<Result<CompletedInvestigation, string>> => {
  const { project, paths } = opened
  const playbook = await loadPlaybook(paths.knowledgeDir, options.playbook)
  if (!playbook.ok) return playbook

  const model = options.model ?? project.agent.model
  const startedAt = new Date()
  const server = await startToolServer()
  try {
    const masked = server.mask(question)
    const dir = investigationDir(
      paths.outDir,
      startedAt.toISOString().slice(0, 10),
      slugify(masked),
    )
    const name = dir.slice(join(paths.outDir, INVESTIGATIONS_DIR).length + 1)
    const result = await runStructured(
      services.agentFor(project),
      {
        prompt: investigationPrompt(masked, opened),
        playbook: playbook.value.text,
        mcpConfig: server.mcpConfig,
        model,
        maxBudgetUsd: options.budgetUsd ?? project.agent.maxBudgetUsd,
        timeoutMs: project.agent.timeoutMinutes * 60_000,
      },
      InvestigationSchema,
    )
    const durationMs = Date.now() - startedAt.getTime()
    await server.record({
      tool: 'agent_run',
      input: {
        investigation: name,
        question: masked,
        playbook: playbook.value.name,
        model: model ?? 'default',
      },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs,
    })
    if (!result.ok) return err(describeAgentError(result.error))

    const investigation = revealDeep(result.value.value, server.reveal)
    const finishedAt = new Date()
    const record: InvestigationRecord = {
      investigation: name,
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
      findings: investigation.findings.length,
      files: ['question.md', 'analysis.md', 'run.json'],
    }
    const written = await writeOutputFiles(dir, {
      'question.md': `${question.trim()}\n`,
      'analysis.md': renderInvestigation(question, investigation, {
        playbook: playbook.value.name,
        generatedAt: finishedAt.toISOString().slice(0, 10),
      }),
      'run.json': `${JSON.stringify(record, null, 2)}\n`,
    })
    if (!written.ok) return err(describeOutputError(written.error))
    return ok({ investigation, record, dir })
  } finally {
    await server.close()
  }
}
