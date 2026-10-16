import { z } from 'zod'
import { RepoAnalysisSchema } from '../../core/agent/index.ts'
import type { ProjectDatabase } from '../../core/storage/index.ts'
import { type RepoState, RepoStateSchema } from './repo-map.schema.ts'

/** Where repository knowledge and catalog entries live; shared by the map and the deep analysis. */
export const REPOS_KNOWLEDGE_DIR = 'repos'
/** Repository names start with a letter or digit, so this name never collides with a map. */
export const CONNECTIONS_FILE = `${REPOS_KNOWLEDGE_DIR}/_connections.md`

export const REPOS_CATALOG = { integration: 'repos', kind: 'repository' } as const

/** The last synced state of each repository, from the local catalog. */
export const readRepoStates = (db: ProjectDatabase): ReadonlyMap<string, RepoState> => {
  const entries = db.catalog(REPOS_CATALOG.integration, REPOS_CATALOG.kind, RepoStateSchema)
  return new Map(entries.ok ? entries.value.map((entry) => [entry.key, entry.data]) : [])
}

export const ANALYSIS_KIND = 'analysis'

export const StoredAnalysisSchema = z.object({
  commit: z.string(),
  analyzedAt: z.string(),
  costUsd: z.number(),
  analysis: RepoAnalysisSchema,
})
export type StoredAnalysis = z.infer<typeof StoredAnalysisSchema>

export const analysisFile = (name: string): string => `${REPOS_KNOWLEDGE_DIR}/${name}.analysis.md`

export const readAnalyses = (db: ProjectDatabase): ReadonlyMap<string, StoredAnalysis> => {
  const entries = db.catalog(REPOS_CATALOG.integration, ANALYSIS_KIND, StoredAnalysisSchema)
  return new Map(entries.ok ? entries.value.map((entry) => [entry.key, entry.data]) : [])
}
