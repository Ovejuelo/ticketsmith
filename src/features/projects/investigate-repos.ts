import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { removeKnowledge, writeKnowledge } from '../../core/knowledge/index.ts'
import {
  type Commit,
  cloneRepository,
  type GrepMatch,
  grep,
  isCloned,
  listFiles,
  projectRepositories,
  type Repository,
  readFile,
  resolveCommit,
  syncClone,
} from '../../core/repos/index.ts'
import type { Services } from '../../core/services/index.ts'
import type { ProjectDatabase } from '../../core/storage/index.ts'
import type { InvestigationOutcome } from './investigate-tickets.ts'
import { renderRepoAnalysis } from './repo-analysis.ts'
import {
  analysisFile,
  CONNECTIONS_FILE,
  REPOS_CATALOG,
  REPOS_KNOWLEDGE_DIR,
  readAnalyses,
  readRepoStates,
} from './repo-catalog.ts'
import type { RepoMap, RepoState } from './repo-map.schema.ts'
import {
  buildRepoMap,
  findConnections,
  GREP_PATTERNS,
  type GrepCategory,
  isManifest,
  type RepoFacts,
  renderConnections,
  renderRepoMap,
} from './repo-map.ts'

const MAX_MATCHES_PER_CATEGORY = 2000

/** Clones the repository if needed, then moves the clone to the latest commit of its fix branch. */
export const syncRepository = async (repository: Repository): Promise<Result<Commit, string>> => {
  const { config, dir } = repository
  if (!isCloned(dir)) {
    await mkdir(dirname(dir), { recursive: true })
    const cloned = await cloneRepository(config.url, dir)
    if (!cloned.ok) return err(`clone failed: ${cloned.error}`)
  }
  const synced = await syncClone(dir, config.branches.fix)
  if (!synced.ok) return synced
  return resolveCommit(dir, 'HEAD')
}

/** Everything the map needs from one commit: files, manifests and grep matches. */
export const collectFacts = async (
  dir: string,
  commit: string,
): Promise<Result<RepoFacts, string>> => {
  const files = await listFiles(dir, commit)
  if (!files.ok) return files
  const manifests: Record<string, string> = {}
  for (const file of files.value.filter(isManifest)) {
    const content = await readFile(dir, commit, file)
    if (content.ok && content.value.kind === 'text') manifests[file] = content.value.text
  }
  const matches = {} as Record<GrepCategory, readonly GrepMatch[]>
  for (const [category, { pattern, ignoreCase }] of Object.entries(GREP_PATTERNS) as Array<
    [GrepCategory, (typeof GREP_PATTERNS)[GrepCategory]]
  >) {
    const found = await grep(dir, { pattern, regex: true, ignoreCase, commit, path: '' })
    matches[category] = found.ok ? found.value.slice(0, MAX_MATCHES_PER_CATEGORY) : []
  }
  return ok({ files: files.value, manifests, matches })
}

const mapRepository = async (
  repository: Repository,
  commit: Commit,
): Promise<Result<RepoMap, string>> => {
  const facts = await collectFacts(repository.dir, commit.id)
  if (!facts.ok) return facts
  const { config } = repository
  return ok(
    buildRepoMap(
      {
        name: config.name,
        url: config.url,
        branches: config.branches,
        runtime: config.runtime.node,
        testCommand: config.testCommand,
      },
      commit,
      facts.value,
    ),
  )
}

/**
 * Syncs every repository's dedicated clone (cloning it when missing, e.g. after `project link`)
 * and maps it into knowledge/repos/<name>.md. A repository whose commit did not move keeps its
 * map; one that cannot be synced keeps its last map and fails the step, so onboarding retries it.
 */
export const investigateRepos = async (
  _services: Services,
  opened: OpenedProject,
  db: ProjectDatabase,
): Promise<Result<InvestigationOutcome, string>> => {
  const repositories = projectRepositories(opened.project, opened.paths)
  const previous = readRepoStates(db)
  const states = new Map<string, RepoState>()
  const failures: string[] = []
  const unchanged: string[] = []

  for (const repository of repositories) {
    const { name } = repository.config
    const last = previous.get(name)
    const commit = await syncRepository(repository)
    if (!commit.ok) {
      failures.push(`${name}: ${commit.error}`)
      if (last !== undefined) states.set(name, last)
      continue
    }
    const fetchedAt = new Date().toISOString()
    if (
      last !== undefined &&
      last.map.commit.id === commit.value.id &&
      sameSettings(last.map, repository)
    ) {
      states.set(name, { fetchedAt, map: last.map })
      unchanged.push(name)
      continue
    }
    const map = await mapRepository(repository, commit.value)
    if (!map.ok) {
      failures.push(`${name}: ${map.error}`)
      if (last !== undefined) states.set(name, last)
      continue
    }
    states.set(name, { fetchedAt, map: map.value })
  }

  db.replaceCatalog(
    REPOS_CATALOG.integration,
    REPOS_CATALOG.kind,
    [...states].map(([key, data]) => ({ key, data })),
  )
  // Rewritten from the states every time, so removed repositories leave no stale map behind.
  await removeKnowledge(opened.paths.knowledgeDir, REPOS_KNOWLEDGE_DIR)
  const maps = [...states.values()].map((state) => state.map)
  const files: Array<readonly [string, string]> = maps.map((map) => [
    `${REPOS_KNOWLEDGE_DIR}/${map.name}.md`,
    renderRepoMap(map),
  ])
  const connections = maps.length > 1 ? findConnections(maps) : []
  if (maps.length > 1) files.push([CONNECTIONS_FILE, renderConnections(maps, connections)])
  // Deep analyses survive the rewrite while their repository is still configured.
  for (const [name, stored] of readAnalyses(db)) {
    if (states.has(name)) files.push([analysisFile(name), renderRepoAnalysis(name, stored)])
  }
  for (const [file, content] of files) {
    const written = await writeKnowledge(
      opened.paths.knowledgeDir,
      file,
      content,
      opened.project.masking,
    )
    if (!written.ok) failures.push(`${file}: ${written.error.message}`)
  }

  if (failures.length > 0) return err(failures.join(' | '))
  const endpoints = maps.reduce((sum, map) => sum + map.endpoints.length, 0)
  const summary = [
    `${maps.map((map) => `${map.name}@${map.commit.id.slice(0, 7)}`).join(', ')}: ${endpoints} endpoints`,
    ...(maps.length > 1 ? [`${connections.length} cross-repo calls`] : []),
  ].join(', ')
  return ok({
    summary: unchanged.length > 0 ? `${summary} (unchanged: ${unchanged.join(', ')})` : summary,
  })
}

/** A map is reused only if the settings it shows still match the configuration. */
const sameSettings = (map: RepoMap, { config }: Repository): boolean =>
  map.url === config.url &&
  map.branches.fix === config.branches.fix &&
  map.branches.feature === config.branches.feature &&
  map.runtime === config.runtime.node &&
  map.testCommand === config.testCommand
