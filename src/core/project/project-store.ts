import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { err, ok, type Result } from '../kernel/index.ts'
import { type Paths, type ProjectPaths, projectPaths } from './paths.ts'
import {
  type AppConfig,
  AppConfigSchema,
  type Project,
  ProjectNameSchema,
  ProjectSchema,
} from './project.schema.ts'

export type ProjectStoreError =
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'invalid'; readonly path: string; readonly issues: string }
  | { readonly kind: 'no-active-project' }
  | { readonly kind: 'io'; readonly path: string; readonly message: string }

const PROJECT_FILE_HEADER = `# Ticketsmith project. This file is meant to be shared (e.g. in a git repo):
# never put secrets here; they live in the system keychain.
`
const GITIGNORE = `# Machine-local state: SQLite catalog, clones, outputs, audit logs. Never share it.
local/
`

/**
 * Projects are folders with a project.yaml. They live under the default projects root or, when
 * cloned elsewhere, are registered as "linked" in the global config.
 */
export class ProjectStore {
  readonly #paths: Paths

  constructor(paths: Paths) {
    this.#paths = paths
  }

  async readConfig(): Promise<Result<AppConfig, ProjectStoreError>> {
    const result = await readFileWith(this.#paths.configFile, JSON.parse, AppConfigSchema)
    return !result.ok && result.error.kind === 'not-found' ? ok({ linked: {} }) : result
  }

  async writeConfig(config: AppConfig): Promise<Result<void, ProjectStoreError>> {
    return writeAtomic(this.#paths.configFile, `${JSON.stringify(config, null, 2)}\n`)
  }

  async setActiveProject(name: string): Promise<Result<void, ProjectStoreError>> {
    const config = await this.readConfig()
    if (!config.ok) return config
    return this.writeConfig({ ...config.value, activeProject: name })
  }

  /** Explicit name (--project or TICKETSMITH_PROJECT) wins over the pinned active project. */
  async resolveProjectName(
    explicit: string | undefined,
  ): Promise<Result<string, ProjectStoreError>> {
    if (explicit !== undefined) {
      const parsed = ProjectNameSchema.safeParse(explicit)
      return parsed.success
        ? ok(parsed.data)
        : err({ kind: 'invalid', path: '--project', issues: z.prettifyError(parsed.error) })
    }
    const config = await this.readConfig()
    if (!config.ok) return config
    return config.value.activeProject !== undefined
      ? ok(config.value.activeProject)
      : err({ kind: 'no-active-project' })
  }

  /** Where a project lives: its linked path, or the default folder under the projects root. */
  async locate(name: string): Promise<Result<ProjectPaths, ProjectStoreError>> {
    const config = await this.readConfig()
    if (!config.ok) return config
    return ok(projectPaths(config.value.linked[name] ?? join(this.#paths.projectsRoot, name)))
  }

  async exists(name: string): Promise<boolean> {
    const located = await this.locate(name)
    return located.ok && (await isFile(located.value.projectFile))
  }

  async list(): Promise<Result<readonly string[], ProjectStoreError>> {
    const config = await this.readConfig()
    if (!config.ok) return config
    let entries: string[] = []
    try {
      entries = await readdir(this.#paths.projectsRoot)
    } catch (error) {
      if (!isNotFound(error)) {
        return err({ kind: 'io', path: this.#paths.projectsRoot, message: String(error) })
      }
    }
    const local = []
    for (const entry of entries) {
      if (await isFile(projectPaths(join(this.#paths.projectsRoot, entry)).projectFile))
        local.push(entry)
    }
    return ok([...new Set([...local, ...Object.keys(config.value.linked)])].sort())
  }

  async load(name: string): Promise<Result<Project, ProjectStoreError>> {
    const located = await this.locate(name)
    if (!located.ok) return located
    return readFileWith(located.value.projectFile, parse, ProjectSchema)
  }

  /** Writes project.yaml (and a .gitignore for local/ the first time) in the project's folder. */
  async save(project: Project): Promise<Result<ProjectPaths, ProjectStoreError>> {
    const located = await this.locate(project.name)
    if (!located.ok) return located
    const paths = located.value
    const written = await writeAtomic(
      paths.projectFile,
      PROJECT_FILE_HEADER + stringify(ProjectSchema.parse(project)),
    )
    if (!written.ok) return written
    if (!(await isFile(paths.gitignore))) {
      const ignored = await writeAtomic(paths.gitignore, GITIGNORE)
      if (!ignored.ok) return ignored
    }
    return ok(paths)
  }

  /**
   * Renames a project: updates project.yaml, moves its default folder (linked folders stay where
   * they are), and updates the active project and the linked registry.
   */
  async rename(from: string, to: string): Promise<Result<ProjectPaths, ProjectStoreError>> {
    const name = ProjectNameSchema.safeParse(to)
    if (!name.success) {
      return err({ kind: 'invalid', path: 'new name', issues: z.prettifyError(name.error) })
    }
    if (await this.exists(to)) {
      return err({ kind: 'invalid', path: 'new name', issues: `Project "${to}" already exists.` })
    }
    const project = await this.load(from)
    if (!project.ok) return project
    const config = await this.readConfig()
    if (!config.ok) return config

    const linkedRoot = config.value.linked[from]
    const root = linkedRoot ?? join(this.#paths.projectsRoot, to)
    if (linkedRoot === undefined) {
      try {
        await mkdir(this.#paths.projectsRoot, { recursive: true, mode: 0o700 })
        await rename(join(this.#paths.projectsRoot, from), root)
      } catch (error) {
        return err({ kind: 'io', path: root, message: String(error) })
      }
    }
    const { [from]: _old, ...linked } = config.value.linked
    const written = await this.writeConfig({
      ...config.value,
      linked: linkedRoot === undefined ? linked : { ...linked, [to]: linkedRoot },
      ...(config.value.activeProject === from ? { activeProject: to } : {}),
    })
    if (!written.ok) return written
    return this.save({ ...project.value, name: to })
  }

  /** Registers a project folder that lives elsewhere (e.g. a clone of the project's git repo). */
  async link(path: string): Promise<Result<Project, ProjectStoreError>> {
    const root = isAbsolute(path) ? path : resolve(path)
    const project = await readFileWith(projectPaths(root).projectFile, parse, ProjectSchema)
    if (!project.ok) return project
    const config = await this.readConfig()
    if (!config.ok) return config
    const written = await this.writeConfig({
      ...config.value,
      linked: { ...config.value.linked, [project.value.name]: root },
    })
    return written.ok ? project : written
  }
}

const readFileWith = async <T>(
  path: string,
  parseText: (text: string) => unknown,
  schema: z.ZodType<T>,
): Promise<Result<T, ProjectStoreError>> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return err({ kind: 'not-found', path })
    return err({ kind: 'io', path, message: String(error) })
  }

  let data: unknown
  try {
    data = parseText(raw)
  } catch (error) {
    return err({ kind: 'invalid', path, issues: `Unreadable file: ${String(error)}` })
  }

  const parsed = schema.safeParse(data)
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: 'invalid', path, issues: z.prettifyError(parsed.error) })
}

// Write-then-rename so a crash never leaves a half-written file; 0600 because it holds emails.
const writeAtomic = async (
  path: string,
  content: string,
): Promise<Result<void, ProjectStoreError>> => {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(tmp, content, { mode: 0o600 })
    await rename(tmp, path)
    return ok(undefined)
  } catch (error) {
    return err({ kind: 'io', path, message: String(error) })
  }
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
