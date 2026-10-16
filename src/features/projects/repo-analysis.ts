import {
  describeAgentError,
  loadPlaybook,
  RepoAnalysisSchema,
  runStructured,
} from '../../core/agent/index.ts'
import type { AgentToolServer, OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { writeKnowledge } from '../../core/knowledge/index.ts'
import type { Services } from '../../core/services/index.ts'
import type { ProjectDatabase } from '../../core/storage/index.ts'
import {
  ANALYSIS_KIND,
  analysisFile,
  REPOS_CATALOG,
  readAnalyses,
  readRepoStates,
  type StoredAnalysis,
} from './repo-catalog.ts'

const list = (items: readonly string[]): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '_None noted._'

export const renderRepoAnalysis = (name: string, stored: StoredAnalysis): string => {
  const { analysis } = stored
  return [
    `# Repository analysis: ${name}`,
    '',
    `> Written by the agent at commit ${stored.commit.slice(0, 12)} on ${stored.analyzedAt.slice(0, 10)}, on top of the map in ${name}.md. Verify with repo_read before relying on a detail.`,
    '',
    '## Overview',
    '',
    analysis.overview,
    '',
    '## Modules',
    '',
    list(analysis.modules.map((m) => `\`${m.path}\`: ${m.purpose}`)),
    '',
    '## Flows',
    '',
    analysis.flows.length > 0
      ? analysis.flows
          .map((flow) =>
            [`### ${flow.name}`, '', ...flow.steps.map((step, i) => `${i + 1}. ${step}`)].join(
              '\n',
            ),
          )
          .join('\n\n')
      : '_None noted._',
    '',
    '## Business rules',
    '',
    list(analysis.businessRules),
    '',
    '## Data model',
    '',
    analysis.dataModel,
    '',
    '## Risks',
    '',
    list(analysis.risks),
    '',
    '## Glossary',
    '',
    list(analysis.glossary.map((g) => `**${g.term}**: ${g.meaning}`)),
    '',
  ].join('\n')
}

export type AnalysisReport = {
  readonly repo: string
  readonly status: 'analyzed' | 'unchanged' | 'failed'
  readonly detail: string
}

/**
 * The agent's deep analysis of each repository, on top of its deterministic map: only repo_* and
 * knowledge_* tools, stored in the catalog and written (masked, never revealed: knowledge is
 * shared) to knowledge/repos/<name>.analysis.md. A commit that was already analyzed is skipped
 * unless `force`, because every analysis costs tokens.
 */
export const analyzeRepositories = async (
  services: Services,
  opened: OpenedProject,
  db: ProjectDatabase,
  startToolServer: () => Promise<AgentToolServer>,
  options: { readonly only?: readonly string[] | undefined; readonly force: boolean },
): Promise<readonly AnalysisReport[]> => {
  const states = readRepoStates(db)
  const analyses = new Map(readAnalyses(db))
  const playbook = await loadPlaybook(opened.paths.knowledgeDir, 'repo-analysis')
  const reports: AnalysisReport[] = []
  const targets = (opened.project.integrations.repos ?? []).filter(
    (repo) => options.only === undefined || options.only.includes(repo.name),
  )
  for (const repo of targets) {
    const state = states.get(repo.name)
    if (state === undefined) {
      reports.push({
        repo: repo.name,
        status: 'failed',
        detail: 'not mapped yet: run `ticketsmith project refresh repos`',
      })
      continue
    }
    const commit = state.map.commit.id
    const previous = analyses.get(repo.name)
    if (!options.force && previous?.commit === commit) {
      reports.push({
        repo: repo.name,
        status: 'unchanged',
        detail: `already analyzed at ${commit.slice(0, 7)}`,
      })
      continue
    }
    if (!playbook.ok) {
      reports.push({ repo: repo.name, status: 'failed', detail: playbook.error })
      continue
    }
    const analyzed = await analyzeOne(
      services,
      opened,
      repo.name,
      commit,
      playbook.value.text,
      startToolServer,
    )
    if (!analyzed.ok) {
      reports.push({ repo: repo.name, status: 'failed', detail: analyzed.error })
      continue
    }
    analyses.set(repo.name, analyzed.value)
    db.replaceCatalog(
      REPOS_CATALOG.integration,
      ANALYSIS_KIND,
      [...analyses].map(([key, data]) => ({ key, data })),
    )
    const written = await writeKnowledge(
      opened.paths.knowledgeDir,
      analysisFile(repo.name),
      renderRepoAnalysis(repo.name, analyzed.value),
      opened.project.masking,
    )
    reports.push(
      written.ok
        ? {
            repo: repo.name,
            status: 'analyzed',
            detail: `$${analyzed.value.costUsd.toFixed(2)} at ${commit.slice(0, 7)}`,
          }
        : { repo: repo.name, status: 'failed', detail: written.error.message },
    )
  }
  return reports
}

const analyzeOne = async (
  services: Services,
  opened: OpenedProject,
  name: string,
  commit: string,
  playbook: string,
  startToolServer: () => Promise<AgentToolServer>,
): Promise<Result<StoredAnalysis, string>> => {
  const { agent } = opened.project
  const server = await startToolServer()
  try {
    const started = Date.now()
    const result = await runStructured(
      services.agent,
      {
        prompt: [
          `Analyze the repository "${name}" of the project "${opened.project.name}" (clone at commit ${commit.slice(0, 12)}).`,
          `Start with knowledge_read("repos/${name}.md"), then read the code with repo_files, repo_search and repo_read (repo: "${name}").`,
          'Follow the playbook in your instructions and finish with the required JSON answer.',
        ].join('\n'),
        playbook,
        mcpConfig: server.mcpConfig,
        model: agent.model,
        maxBudgetUsd: agent.maxBudgetUsd,
        timeoutMs: agent.timeoutMinutes * 60_000,
      },
      RepoAnalysisSchema,
    )
    await server.record({
      tool: 'agent_run',
      input: { repo: name, playbook: 'repo-analysis', model: agent.model ?? 'default' },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs: Date.now() - started,
    })
    if (!result.ok) return err(describeAgentError(result.error))
    return ok({
      commit,
      analyzedAt: new Date().toISOString(),
      costUsd: result.value.runs.reduce((sum, run) => sum + run.costUsd, 0),
      analysis: result.value.value,
    })
  } finally {
    await server.close()
  }
}
