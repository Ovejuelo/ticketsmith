import { isAbsolute, join } from 'node:path'

/** Global locations (XDG). Each project then lives in its own folder, see ProjectPaths. */
export type Paths = {
  readonly configDir: string
  /** Active project and linked projects. */
  readonly configFile: string
  /** Default home of every project: <data>/ticketsmith/projects/<name>. */
  readonly projectsRoot: string
  /** Phase-1 locations, read only to migrate profiles. */
  readonly legacy: {
    readonly profilesDir: string
    readonly dataDir: (profile: string) => string
  }
}

/** The git-ready folder of one project: shared text at the root, machine-local state in local/. */
export type ProjectPaths = {
  readonly root: string
  readonly projectFile: string
  readonly gitignore: string
  readonly knowledgeDir: string
  readonly localDir: string
  readonly sqlite: string
  readonly outDir: string
  readonly auditDir: string
  readonly cacheDir: string
  /** Dedicated clones, one folder per repository. */
  readonly reposDir: string
  /** Proposed database changes awaiting a human decision (real values: owner-only, never shared). */
  readonly changesDir: string
}

type Env = Readonly<Record<string, string | undefined>>

// XDG says relative values must be ignored.
const xdgDir = (value: string | undefined, fallback: string): string =>
  value && isAbsolute(value) ? value : fallback

export const resolvePaths = (env: Env, home: string): Paths => {
  const configDir = join(xdgDir(env['XDG_CONFIG_HOME'], join(home, '.config')), 'ticketsmith')
  const dataRoot = join(xdgDir(env['XDG_DATA_HOME'], join(home, '.local', 'share')), 'ticketsmith')
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    projectsRoot: join(dataRoot, 'projects'),
    legacy: {
      profilesDir: join(configDir, 'profiles'),
      dataDir: (profile) => join(dataRoot, profile),
    },
  }
}

export const projectPaths = (root: string): ProjectPaths => {
  const localDir = join(root, 'local')
  return {
    root,
    projectFile: join(root, 'project.yaml'),
    gitignore: join(root, '.gitignore'),
    knowledgeDir: join(root, 'knowledge'),
    localDir,
    sqlite: join(localDir, 'project.sqlite'),
    outDir: join(localDir, 'out'),
    auditDir: join(localDir, 'audit'),
    cacheDir: join(localDir, 'cache'),
    reposDir: join(localDir, 'repos'),
    changesDir: join(localDir, 'changes'),
  }
}
