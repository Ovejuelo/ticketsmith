import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Paths } from './paths.ts'
import { LegacyProfileSchema, ProjectSchema } from './project.schema.ts'
import type { ProjectStore } from './project-store.ts'

export type MigrationReport = {
  readonly migrated: readonly string[]
  readonly failed: readonly { readonly file: string; readonly reason: string }[]
}

const LegacyConfigSchema = z.looseObject({ activeProfile: z.string().optional() })

/**
 * Converts phase-1 profiles into projects, once. Names are kept, so keychain entries
 * (ticketsmith/<name>/jira-token) keep working. Outputs and audit logs move into the project's
 * local/ folder, and each converted profile file is renamed to *.migrated. Safe to run every time.
 */
export const migrateLegacyProfiles = async (
  paths: Paths,
  store: ProjectStore,
): Promise<MigrationReport> => {
  let files: string[]
  try {
    files = (await readdir(paths.legacy.profilesDir)).filter((file) => file.endsWith('.json'))
  } catch {
    return { migrated: [], failed: [] }
  }

  const migrated: string[] = []
  const failed: { file: string; reason: string }[] = []
  for (const file of files) {
    const path = join(paths.legacy.profilesDir, file)
    const legacy = LegacyProfileSchema.safeParse(await readJson(path))
    if (!legacy.success) {
      failed.push({ file: path, reason: z.prettifyError(legacy.error) })
      continue
    }
    const { name, tickets, masking } = legacy.data
    if (!(await store.exists(name))) {
      const saved = await store.save(
        ProjectSchema.parse({ version: 2, name, integrations: { tickets }, masking }),
      )
      if (!saved.ok) {
        failed.push({ file: path, reason: saved.error.kind })
        continue
      }
      for (const dir of ['out', 'audit'] as const) {
        await moveIfPresent(join(paths.legacy.dataDir(name), dir), join(saved.value.localDir, dir))
      }
    }
    await rename(path, `${path}.migrated`)
    migrated.push(name)
  }

  await migrateActiveProfile(paths, store)
  return { migrated, failed }
}

const migrateActiveProfile = async (paths: Paths, store: ProjectStore): Promise<void> => {
  const legacy = LegacyConfigSchema.safeParse(await readJson(paths.configFile))
  const active = legacy.success ? legacy.data.activeProfile : undefined
  if (active === undefined) return
  const config = await store.readConfig()
  if (config.ok && config.value.activeProject === undefined) {
    await store.writeConfig({ ...config.value, activeProject: active })
  }
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const moveIfPresent = async (from: string, to: string): Promise<void> => {
  try {
    await stat(from)
  } catch {
    return
  }
  try {
    await stat(to)
    return // never overwrite data that already exists in the project
  } catch {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    await rename(from, to)
  }
}
