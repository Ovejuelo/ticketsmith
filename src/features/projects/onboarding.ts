import type { OpenedProject } from '../../core/cli/index.ts'
import { orFail } from '../../core/cli/index.ts'
import { type BriefSection, renderBrief, writeKnowledge } from '../../core/knowledge/index.ts'
import {
  configuredIntegrations,
  describeProjectError,
  type Integration,
} from '../../core/project/index.ts'
import type { Services } from '../../core/services/index.ts'
import {
  describeStorageError,
  type ProjectDatabase,
  type StepStatus,
  withProjectDatabase,
} from '../../core/storage/index.ts'
import { DATABASES_KNOWLEDGE_DIR, investigateDatabases } from './investigate-databases.ts'
import { investigateRepos } from './investigate-repos.ts'
import { investigateTickets, TICKETS_KNOWLEDGE_FILE } from './investigate-tickets.ts'
import { REPOS_KNOWLEDGE_DIR } from './repo-catalog.ts'

export const BRIEF_FILE = 'brief.md'

type Investigator = {
  readonly title: string
  readonly knowledgeFile: string
  readonly run: typeof investigateTickets
}

/** One investigation per integration. */
const INVESTIGATORS: Readonly<Record<Integration, Investigator>> = {
  tickets: { title: 'JIRA', knowledgeFile: TICKETS_KNOWLEDGE_FILE, run: investigateTickets },
  databases: {
    title: 'Databases',
    knowledgeFile: `${DATABASES_KNOWLEDGE_DIR}/`,
    run: investigateDatabases,
  },
  repos: { title: 'Repositories', knowledgeFile: `${REPOS_KNOWLEDGE_DIR}/`, run: investigateRepos },
}

export type StepReport = {
  readonly step: Integration
  readonly status: StepStatus
  readonly detail: string
}

/** Configured integrations whose investigation is missing or failed: what `init` resumes. */
export const pendingInvestigations = async (
  opened: OpenedProject,
): Promise<readonly Integration[]> =>
  orFail(
    await withProjectDatabase(opened.paths.sqlite, (db) =>
      configuredIntegrations(opened.project).filter(
        (integration) => db.step(integration)?.status !== 'done',
      ),
    ),
    describeStorageError,
  )

/**
 * Runs the investigations of the given integrations (default: every configured one), records each
 * step in the local store, then regenerates the project brief. A failing step never stops the
 * others; its error is kept so `project status` and the next `init` can show and retry it.
 */
export const investigateProject = async (
  services: Services,
  opened: OpenedProject,
  only?: readonly Integration[],
): Promise<readonly StepReport[]> =>
  orFail(
    await withProjectDatabase(opened.paths.sqlite, async (db) => {
      const targets = configuredIntegrations(opened.project).filter(
        (integration) => only === undefined || only.includes(integration),
      )
      const reports: StepReport[] = []
      for (const integration of targets) {
        reports.push(await runStep(services, opened, db, integration))
      }
      await writeBrief(opened, db)
      return reports
    }),
    describeStorageError,
  )

const runStep = async (
  services: Services,
  opened: OpenedProject,
  db: ProjectDatabase,
  integration: Integration,
): Promise<StepReport> => {
  db.setStep(integration, 'pending')
  let outcome: StepReport
  try {
    const result = await INVESTIGATORS[integration].run(services, opened, db)
    outcome = result.ok
      ? { step: integration, status: 'done', detail: result.value.summary }
      : { step: integration, status: 'failed', detail: result.error }
  } catch (error) {
    outcome = {
      step: integration,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  db.setStep(integration, outcome.status, outcome.detail)
  return outcome
}

const writeBrief = async (opened: OpenedProject, db: ProjectDatabase): Promise<void> => {
  const integrations = configuredIntegrations(opened.project)
  const sections: BriefSection[] = integrations.flatMap((integration) => {
    const step = db.step(integration)
    return step?.status === 'done'
      ? [
          {
            title: INVESTIGATORS[integration].title,
            file: INVESTIGATORS[integration].knowledgeFile,
            summary: step.detail ?? '',
          },
        ]
      : []
  })
  orFail(
    await writeKnowledge(
      opened.paths.knowledgeDir,
      BRIEF_FILE,
      renderBrief({
        project: opened.project.name,
        integrations,
        sections,
        generatedAt: new Date().toISOString().slice(0, 10),
      }),
      opened.project.masking,
    ),
    (error) => describeProjectError({ kind: 'io', path: error.path, message: error.message }),
  )
}
