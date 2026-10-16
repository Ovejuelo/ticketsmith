import { posix } from 'node:path'
import type { Commit, GrepMatch } from '../../core/repos/index.ts'
import type { Endpoint, RepoMap } from './repo-map.schema.ts'

/**
 * Deterministic repository map: built from the tracked file list, a few manifests and `git grep`
 * matches, without an LLM. Every detection is generic data in the tables below; nothing here
 * knows a specific product.
 */

/** Manifests read in full (root and one level down, for monorepos). */
export const MANIFEST_NAMES = new Set([
  'package.json',
  '.nvmrc',
  '.node-version',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'composer.json',
  'Gemfile',
])

export const isManifest = (file: string): boolean =>
  MANIFEST_NAMES.has(posix.basename(file)) && file.split('/').length <= 2

/**
 * Loose prefilters for `git grep -E`, one search per category. Only portable POSIX ERE (no `\b`,
 * `\s` or `\w`: macOS's regex lacks them); the extractors below do the precise matching in JS.
 */
export const GREP_PATTERNS: Readonly<
  Record<GrepCategory, { readonly pattern: string; readonly ignoreCase: boolean }>
> = {
  routes: {
    pattern: [
      String.raw`\.(get|post|put|patch|delete|all|use)\(`,
      String.raw`@(Get|Post|Put|Patch|Delete|All|Request)(Mapping)?\(`,
      String.raw`@[[:alnum:]_]+\.(route|get|post|put|patch|delete)\(`,
      'Route::',
      String.raw`\.(GET|POST|PUT|PATCH|DELETE|HandleFunc)\(`,
    ].join('|'),
    ignoreCase: false,
  },
  screens: { pattern: '<Route|path:', ignoreCase: false },
  calls: {
    pattern: String.raw`(axios|http|api|client|request|instance)\.(get|post|put|patch|delete)\(|fetch\(`,
    ignoreCase: false,
  },
  models: {
    pattern: [
      String.raw`sequelize\.define\(`,
      '@Entity',
      String.raw`mongoose\.model\(`,
      String.raw`^model [[:alnum:]_]+ *\{`,
      String.raw`models\.Model`,
      'extends Model',
    ].join('|'),
    ignoreCase: false,
  },
  sql: {
    pattern: 'select .* from |insert into |update [[:alnum:]_`]+ set |delete from ',
    ignoreCase: true,
  },
}
export type GrepCategory = 'routes' | 'screens' | 'calls' | 'models' | 'sql'

export type RepoFacts = {
  readonly files: readonly string[]
  /** Manifest path → content. */
  readonly manifests: Readonly<Record<string, string>>
  readonly matches: Readonly<Record<GrepCategory, readonly GrepMatch[]>>
}

const NODE_PACKAGES: ReadonlyArray<readonly [string, string, 'framework' | 'data' | 'test']> = [
  ['express', 'Express', 'framework'],
  ['@nestjs/core', 'NestJS', 'framework'],
  ['koa', 'Koa', 'framework'],
  ['fastify', 'Fastify', 'framework'],
  ['@hapi/hapi', 'hapi', 'framework'],
  ['next', 'Next.js', 'framework'],
  ['react', 'React', 'framework'],
  ['vue', 'Vue', 'framework'],
  ['@angular/core', 'Angular', 'framework'],
  ['svelte', 'Svelte', 'framework'],
  ['react-router-dom', 'React Router', 'framework'],
  ['axios', 'axios', 'framework'],
  ['sequelize', 'Sequelize', 'data'],
  ['typeorm', 'TypeORM', 'data'],
  ['@prisma/client', 'Prisma', 'data'],
  ['knex', 'Knex', 'data'],
  ['mongoose', 'Mongoose', 'data'],
  ['mysql2', 'mysql2', 'data'],
  ['mysql', 'mysql', 'data'],
  ['pg', 'node-postgres', 'data'],
  ['objection', 'Objection', 'data'],
  ['jest', 'Jest', 'test'],
  ['mocha', 'Mocha', 'test'],
  ['vitest', 'Vitest', 'test'],
  ['jasmine', 'Jasmine', 'test'],
  ['karma', 'Karma', 'test'],
  ['cypress', 'Cypress', 'test'],
  ['@playwright/test', 'Playwright', 'test'],
  ['react-scripts', 'Create React App (Jest)', 'test'],
]

/** Other ecosystems: manifest → (text in it → label). */
const OTHER_MANIFESTS: ReadonlyArray<
  readonly [string, string, ReadonlyArray<readonly [RegExp, string]>]
> = [
  [
    'requirements.txt|pyproject.toml|Pipfile',
    'Python',
    [
      [/\bdjango\b/i, 'Django'],
      [/\bflask\b/i, 'Flask'],
      [/\bfastapi\b/i, 'FastAPI'],
      [/\bsqlalchemy\b/i, 'SQLAlchemy'],
      [/\bpytest\b/i, 'pytest'],
    ],
  ],
  [
    'pom.xml|build.gradle|build.gradle.kts',
    'Java/Kotlin',
    [
      [/spring-boot/, 'Spring Boot'],
      [/hibernate|spring-boot-starter-data-jpa/, 'JPA/Hibernate'],
      [/junit/i, 'JUnit'],
    ],
  ],
  [
    'go.mod',
    'Go',
    [
      [/gin-gonic\/gin/, 'Gin'],
      [/labstack\/echo/, 'Echo'],
      [/gorm\.io/, 'GORM'],
    ],
  ],
  [
    'composer.json',
    'PHP',
    [
      [/laravel\/framework/, 'Laravel'],
      [/symfony\//, 'Symfony'],
      [/phpunit/, 'PHPUnit'],
    ],
  ],
  [
    'Gemfile',
    'Ruby',
    [
      [/['"]rails['"]/, 'Rails'],
      [/rspec/, 'RSpec'],
    ],
  ],
]

const LANGUAGES: Readonly<Record<string, string>> = {
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  ts: 'TypeScript',
  tsx: 'TypeScript (TSX)',
  vue: 'Vue',
  svelte: 'Svelte',
  py: 'Python',
  java: 'Java',
  kt: 'Kotlin',
  go: 'Go',
  php: 'PHP',
  rb: 'Ruby',
  cs: 'C#',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sh: 'Shell',
}

const ENTRY_FILE =
  /^(src\/|app\/|server\/)?(index|main|server|app)\.(js|mjs|cjs|ts|jsx|tsx|py|go)$|^manage\.py$|^cmd\/[^/]+\/main\.go$/
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]+\.py$|Test\.java$/
const CONFIG_FILE =
  /(^|\/)\.env\.(example|sample|template)$|(^|\/)config\/[^/]+$|\.config\.[cm]?[jt]s$|(^|\/)settings\.py$|(^|\/)application(-\w+)?\.(ya?ml|properties)$|(^|\/)docker-compose\.ya?ml$|(^|\/)Dockerfile$/
const MODEL_DIR = /(^|\/)(models?|entities|entity|schemas?)\//
const MIGRATION_DIR = /^(.*?(^|\/)(migrations?|db\/migrate))\//

type PackageJson = {
  readonly main?: string
  readonly bin?: string | Record<string, string>
  readonly scripts?: Record<string, string>
  readonly engines?: { readonly node?: string }
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const parsePackage = (content: string | undefined): PackageJson | null => {
  if (content === undefined) return null
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : null
  } catch {
    return null
  }
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)]

const countBy = (items: readonly string[]): Array<[string, number]> => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts]
}

const DEFAULT_TEST_SCRIPT = /no test specified/

/** Node version from .nvmrc, .node-version or engines.node (root only). */
export const detectRuntime = (manifests: Readonly<Record<string, string>>): string | undefined => {
  const pinned = (manifests['.nvmrc'] ?? manifests['.node-version'])?.trim().replace(/^v/, '')
  if (pinned) return pinned
  const engines = parsePackage(manifests['package.json'])?.engines?.node?.trim()
  return engines || undefined
}

/** The command that runs the repository's tests, from its manifests. */
export const detectTestCommand = (
  files: readonly string[],
  manifests: Readonly<Record<string, string>>,
): string | undefined => {
  const pkg = parsePackage(manifests['package.json'])
  const script = pkg?.scripts?.['test']
  if (script !== undefined && !DEFAULT_TEST_SCRIPT.test(script)) {
    if (files.includes('pnpm-lock.yaml')) return 'pnpm test'
    if (files.includes('yarn.lock')) return 'yarn test'
    return 'npm test'
  }
  if (files.includes('go.mod')) return 'go test ./...'
  if (files.includes('gradlew')) return './gradlew test'
  if (files.includes('pom.xml')) return 'mvn test'
  const python = ['requirements.txt', 'pyproject.toml', 'Pipfile']
    .map((name) => manifests[name] ?? '')
    .join('\n')
  if (/\bpytest\b/i.test(python)) return 'pytest'
  return undefined
}

const detectStack = (manifests: Readonly<Record<string, string>>): string[] => {
  const labels: string[] = []
  for (const [path, content] of Object.entries(manifests)) {
    const name = posix.basename(path)
    if (name === 'package.json') {
      const pkg = parsePackage(content)
      const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
      const where = path === 'package.json' ? '' : ` (${posix.dirname(path)})`
      const found = NODE_PACKAGES.filter(([dep]) => deps[dep] !== undefined).map(
        ([dep, label]) => `${label} ${deps[dep]}`,
      )
      if (found.length > 0) labels.push(`Node.js${where}: ${found.join(', ')}`)
      continue
    }
    for (const [names, language, rules] of OTHER_MANIFESTS) {
      if (!names.split('|').includes(name)) continue
      const found = rules.filter(([pattern]) => pattern.test(content)).map(([, label]) => label)
      labels.push(found.length > 0 ? `${language}: ${found.join(', ')}` : language)
    }
  }
  return unique(labels)
}

const detectEntryPoints = (
  files: readonly string[],
  manifests: Readonly<Record<string, string>>,
): string[] => {
  const pkg = parsePackage(manifests['package.json'])
  const declared = [
    ...(pkg?.main ? [`${pkg.main} (package.json main)`] : []),
    ...(typeof pkg?.bin === 'string'
      ? [`${pkg.bin} (bin)`]
      : Object.entries(pkg?.bin ?? {}).map(([name, file]) => `${file} (bin ${name})`)),
    ...(pkg?.scripts?.['start'] ? [`npm start: \`${pkg.scripts['start']}\``] : []),
  ]
  return unique([...declared, ...files.filter((file) => ENTRY_FILE.test(file))]).slice(0, 15)
}

// --- Routes and calls: extract (method, path) from the matched lines ---

const ROUTE_EXTRACTORS: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => [string, string]]> =
  [
    [
      /\b(?:app|router|server|api|routes|r)\.(get|post|put|patch|delete|all|use)\(\s*['"`](\/[^'"`]*)/,
      (m) => [m[1] ?? '', m[2] ?? ''],
    ],
    [/@(Get|Post|Put|Patch|Delete|All)\(\s*['"]([^'"]*)/, (m) => [m[1] ?? '', m[2] ?? '']],
    [
      /@(?:app|router|bp|blueprint|api)\.(route|get|post|put|patch|delete)\(\s*['"]([^'"]+)/,
      (m) => [m[1] === 'route' ? 'any' : (m[1] ?? ''), m[2] ?? ''],
    ],
    [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\((?:\s*(?:value|path)\s*=\s*)?\{?\s*"([^"]*)/,
      (m) => [m[1] === 'Request' ? 'any' : (m[1] ?? ''), m[2] ?? ''],
    ],
    [/Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)/, (m) => [m[1] ?? '', m[2] ?? '']],
    [
      /\.(GET|POST|PUT|PATCH|DELETE|HandleFunc)\(\s*"(\/[^"]*)/,
      (m) => [m[1] === 'HandleFunc' ? 'any' : (m[1] ?? ''), m[2] ?? ''],
    ],
  ]

const SCREEN_EXTRACTORS: ReadonlyArray<RegExp> = [
  /<Route[^>]*path=\{?\s*['"`]([^'"`]+)/,
  /^\s*path:\s*['"](\/[^'"]*)/,
]

const CALL_EXTRACTORS: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => [string, string]]> =
  [
    [
      /\b(?:axios|http|api|client|request|\$http|instance)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/,
      (m) => [m[1] ?? '', m[2] ?? ''],
    ],
    [/\bfetch\(\s*['"`]([^'"`]+)/, (m) => ['get', m[1] ?? '']],
  ]

const extract = (
  matches: readonly GrepMatch[],
  extractors: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => [string, string]]>,
  limit: number,
): Endpoint[] =>
  matches
    .flatMap((match) => {
      for (const [pattern, pick] of extractors) {
        const found = pattern.exec(match.text)
        if (found !== null) {
          const [method, path] = pick(found)
          return [{ method: method.toUpperCase(), path, file: match.path, line: match.line }]
        }
      }
      return []
    })
    .slice(0, limit)

/** `/api/accounts/${id}?x=1`, `{id}`, `<id>`, `[id]` → `/api/accounts/:param`. */
export const normalizeRoute = (path: string): string => {
  const withoutHost = path.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '')
  const segments = withoutHost
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) =>
      /^(:\w+\??|\{[^}]*\}|<[^>]*>|\[[^\]]*\]|\$\{[^}]*\}|\*)$/.test(segment) ||
      segment.includes('${')
        ? ':param'
        : segment,
    )
  return `/${segments.join('/')}`
}

export const buildRepoMap = (
  repository: {
    readonly name: string
    readonly url: string
    readonly branches: { readonly fix: string; readonly feature: string }
    readonly runtime?: string | undefined
    readonly testCommand?: string | undefined
  },
  commit: Commit,
  facts: RepoFacts,
): RepoMap => {
  const { files, manifests } = facts
  // Mocks and fixtures in tests are not the application's endpoints, calls or data access.
  const inCode = (list: readonly GrepMatch[]) => list.filter((match) => !TEST_FILE.test(match.path))
  const matches = {
    routes: inCode(facts.matches.routes),
    screens: inCode(facts.matches.screens),
    calls: inCode(facts.matches.calls),
    models: inCode(facts.matches.models),
    sql: inCode(facts.matches.sql),
  }
  const extension = (file: string) => posix.extname(file).slice(1).toLowerCase()
  const languages = countBy(files.flatMap((file) => LANGUAGES[extension(file)] ?? []))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  // Folders up to two levels deep, each with the files it holds (directly or below).
  const structure = countBy(
    files.flatMap((file) => {
      const dirs = file.split('/').slice(0, -1)
      return dirs.length === 0 ? [] : [dirs.slice(0, 2).join('/')]
    }),
  )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 40)

  const testFiles = files.filter((file) => TEST_FILE.test(file))
  const migrations = countBy(
    files.flatMap((file) => {
      const match = MIGRATION_DIR.exec(file)
      return match?.[1] === undefined ? [] : [match[1]]
    }),
  )

  return {
    name: repository.name,
    url: repository.url,
    branches: repository.branches,
    commit,
    ...(repository.runtime === undefined ? {} : { runtime: repository.runtime }),
    ...(repository.testCommand === undefined ? {} : { testCommand: repository.testCommand }),
    fileCount: files.length,
    languages,
    structure,
    stack: detectStack(manifests),
    entryPoints: detectEntryPoints(files, manifests),
    endpoints: extract(matches.routes, ROUTE_EXTRACTORS, 200),
    screens: matches.screens
      .flatMap((match) => {
        for (const pattern of SCREEN_EXTRACTORS) {
          const found = pattern.exec(match.text)
          if (found?.[1] !== undefined) {
            return [{ method: 'SCREEN', path: found[1], file: match.path, line: match.line }]
          }
        }
        return []
      })
      .slice(0, 100),
    calls: extract(matches.calls, CALL_EXTRACTORS, 200),
    models: unique([
      ...matches.models.map((match) => match.path),
      ...files.filter(
        (file) => MODEL_DIR.test(file) && /\.(js|ts|py|java|kt|go|php|rb|prisma)$/.test(file),
      ),
    ]).slice(0, 60),
    migrations,
    sqlFiles: unique([
      ...files.filter((file) => file.endsWith('.sql')),
      ...matches.sql.map((match) => match.path),
    ]).slice(0, 40),
    configFiles: files.filter((file) => CONFIG_FILE.test(file)).slice(0, 30),
    tests: {
      count: testFiles.length,
      dirs: unique(
        testFiles.map((file) => {
          const dir = posix.dirname(file)
          return dir === '.' ? '(root)' : dir
        }),
      ).slice(0, 15),
    },
  }
}

// --- Rendering ---

const list = (items: readonly string[], empty: string): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `_${empty}_`

const endpointLines = (endpoints: readonly Endpoint[], empty: string): string =>
  list(
    endpoints.map((e) => `\`${e.method} ${e.path}\` — ${e.file}:${e.line}`),
    empty,
  )

export const renderRepoMap = (map: RepoMap): string =>
  [
    `# Repository: ${map.name}`,
    '',
    `- Clone URL: ${map.url}`,
    `- Branches: fixes from \`${map.branches.fix}\`, features from \`${map.branches.feature}\`. The clone follows \`${map.branches.fix}\`.`,
    `- Mapped commit: ${map.commit.id.slice(0, 12)} (${map.commit.date})`,
    `- Runtime: ${map.runtime === undefined ? 'not detected' : `Node ${map.runtime}`}`,
    `- Tests: ${map.testCommand === undefined ? 'no test command detected' : `\`${map.testCommand}\``}`,
    `- ${map.fileCount} tracked files. Search with \`repo_search\`, read with \`repo_read\`, list with \`repo_files\`.`,
    '',
    'Generated from the code without an LLM: a starting point, not the whole truth.',
    '',
    '## Stack',
    '',
    list(map.stack, 'No manifest detected.'),
    '',
    '## Languages',
    '',
    list(
      map.languages.map(([language, count]) => `${language}: ${count} files`),
      'None detected.',
    ),
    '',
    '## Structure',
    '',
    list(
      map.structure.map(([dir, count]) => `${dir}/ (${count} files)`),
      'All files are at the root.',
    ),
    '',
    '## Entry points',
    '',
    list(map.entryPoints, 'None detected.'),
    '',
    '## HTTP endpoints',
    '',
    endpointLines(map.endpoints, 'None detected.'),
    '',
    '## Screens (front-end routes)',
    '',
    endpointLines(map.screens, 'None detected.'),
    '',
    '## Outgoing HTTP calls',
    '',
    endpointLines(map.calls, 'None detected.'),
    '',
    '## Data access',
    '',
    '### Models',
    '',
    list(map.models, 'None detected.'),
    '',
    '### Migrations',
    '',
    list(
      map.migrations.map(([dir, count]) => `${dir}/ (${count} files)`),
      'None detected.',
    ),
    '',
    '### SQL',
    '',
    list(map.sqlFiles, 'No SQL files or inline SQL detected.'),
    '',
    '## Configuration files',
    '',
    list(map.configFiles, 'None detected.'),
    '',
    '## Tests',
    '',
    map.tests.count > 0
      ? `${map.tests.count} test files in: ${map.tests.dirs.join(', ')}`
      : '_No test files detected._',
    '',
  ].join('\n')

// --- Connections between repositories ---

export type Connection = {
  readonly call: Endpoint & { readonly repo: string }
  readonly endpoint: Endpoint & { readonly repo: string }
  /** The mount prefix (e.g. `app.use('/api/accounts', …)`) the match relied on, if any. */
  readonly via: string | undefined
}

const segmentsOf = (path: string): string[] =>
  normalizeRoute(path)
    .split('/')
    .filter((segment) => segment !== '')

/** A route parameter accepts any segment; a dynamic segment in a call only matches a parameter. */
const routeMatches = (route: readonly string[], call: readonly string[]): boolean =>
  route.length === call.length &&
  route.every((segment, i) => segment === ':param' || segment === call[i])

/**
 * Matches each repository's outgoing calls with the endpoints of the other repositories: a full
 * path match, or a mounted router (`use('/api/accounts')` + `get('/:id')`) within the same repo.
 */
export const findConnections = (maps: readonly RepoMap[]): Connection[] => {
  const connections: Connection[] = []
  for (const caller of maps) {
    for (const call of caller.calls) {
      const target = segmentsOf(call.path)
      for (const server of maps) {
        if (server.name === caller.name) continue
        const mounts = server.endpoints.filter((e) => e.method === 'USE').map((e) => e.path)
        const routes = server.endpoints.filter((e) => e.method !== 'USE')
        for (const endpoint of routes) {
          if (
            endpoint.method !== 'ANY' &&
            endpoint.method !== 'ALL' &&
            endpoint.method !== call.method
          ) {
            continue
          }
          const own = segmentsOf(endpoint.path)
          if (routeMatches(own, target)) {
            connections.push({
              call: { ...call, repo: caller.name },
              endpoint: { ...endpoint, repo: server.name },
              via: undefined,
            })
            continue
          }
          const mount = mounts.find((prefix) =>
            routeMatches([...segmentsOf(prefix), ...own], target),
          )
          if (mount !== undefined) {
            connections.push({
              call: { ...call, repo: caller.name },
              endpoint: { ...endpoint, repo: server.name },
              via: mount,
            })
          }
        }
      }
    }
  }
  return connections
}

export const renderConnections = (
  maps: readonly RepoMap[],
  connections: readonly Connection[],
): string =>
  [
    '# Connections between repositories',
    '',
    `Outgoing HTTP calls matched with the endpoints of the other repositories (${maps.map((m) => m.name).join(', ')}). Heuristic: confirm with \`repo_read\` before relying on it.`,
    '',
    connections.length > 0
      ? connections
          .map(
            (c) =>
              `- \`${c.call.method} ${normalizeRoute(c.call.path)}\`: ${c.call.repo} ${c.call.file}:${c.call.line} → ${c.endpoint.repo} ${c.endpoint.file}:${c.endpoint.line}${c.via === undefined ? '' : ` (mounted at \`${c.via}\`)`}`,
          )
          .join('\n')
      : '_No call matched an endpoint of another repository._',
    '',
  ].join('\n')
