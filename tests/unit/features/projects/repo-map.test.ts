import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cloneRepository, resolveCommit } from '#src/core/repos/index.ts'
import { collectFacts } from '#src/features/projects/investigate-repos.ts'
import type { RepoMap } from '#src/features/projects/repo-map.schema.ts'
import {
  buildRepoMap,
  detectRuntime,
  detectTestCommand,
  findConnections,
  normalizeRoute,
  renderConnections,
  renderRepoMap,
} from '#src/features/projects/repo-map.ts'
import { TestRemote } from '#tests/support/git-repos.ts'

describe('normalizeRoute', () => {
  it.each([
    ['/api/accounts/${id}', '/api/accounts/:param'],
    ['/api/accounts/:id/deactivate', '/api/accounts/:param/deactivate'],
    ['/users/{userId}', '/users/:param'],
    ['/users/<int:id>', '/users/:param'],
    ['https://api.acme.dev/v1/items?page=2', '/v1/items'],
    ['accounts/', '/accounts'],
    ['/', '/'],
  ])('%s → %s', (path, normalized) => {
    expect(normalizeRoute(path)).toBe(normalized)
  })
})

describe('detection from manifests', () => {
  it('reads the Node version from .nvmrc, .node-version or engines', () => {
    expect(detectRuntime({ '.nvmrc': 'v20.11.1\n' })).toBe('20.11.1')
    expect(detectRuntime({ '.node-version': '14\n' })).toBe('14')
    expect(detectRuntime({ 'package.json': '{"engines":{"node":">=18"}}' })).toBe('>=18')
    expect(detectRuntime({})).toBeUndefined()
  })

  it('derives the test command from the manifests and lockfiles', () => {
    const pkg = { 'package.json': '{"scripts":{"test":"jest"}}' }
    expect(detectTestCommand(['package.json'], pkg)).toBe('npm test')
    expect(detectTestCommand(['package.json', 'pnpm-lock.yaml'], pkg)).toBe('pnpm test')
    expect(detectTestCommand(['package.json', 'yarn.lock'], pkg)).toBe('yarn test')
    expect(
      detectTestCommand(['package.json'], {
        'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}',
      }),
    ).toBeUndefined()
    expect(detectTestCommand(['go.mod'], { 'go.mod': 'module x' })).toBe('go test ./...')
    expect(detectTestCommand(['pom.xml'], {})).toBe('mvn test')
    expect(detectTestCommand(['requirements.txt'], { 'requirements.txt': 'pytest==8\n' })).toBe(
      'pytest',
    )
  })
})

describe('repository maps from real repositories', () => {
  const remotes: TestRemote[] = []
  let work: string
  let api: RepoMap
  let web: RepoMap

  const mapFixture = async (fixture: string, name: string): Promise<RepoMap> => {
    const remote = new TestRemote({ fixture })
    remotes.push(remote)
    const dir = join(work, name)
    const cloned = await cloneRepository(remote.url, dir)
    if (!cloned.ok) throw new Error(cloned.error)
    const commit = await resolveCommit(dir, 'HEAD')
    if (!commit.ok) throw new Error(commit.error)
    const facts = await collectFacts(dir, commit.value.id)
    if (!facts.ok) throw new Error(facts.error)
    return buildRepoMap(
      {
        name,
        url: `git@git.acme.dev:acme/${name}.git`,
        branches: { fix: 'main', feature: 'main' },
        runtime: detectRuntime(facts.value.manifests),
        testCommand: detectTestCommand(facts.value.files, facts.value.manifests),
      },
      commit.value,
      facts.value,
    )
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ticketsmith-maps-'))
    api = await mapFixture('api-express', 'api')
    web = await mapFixture('web-react', 'web')
  })

  afterAll(() => {
    for (const remote of remotes) remote[Symbol.dispose]()
    rmSync(work, { recursive: true, force: true })
  })

  it('maps a back-end: stack, entry points, endpoints, data access and tests', () => {
    expect(api.stack).toEqual([
      'Node.js: Express ^4.19.2, Sequelize ^6.37.0, mysql2 ^3.9.0, Mocha ^10.4.0',
    ])
    expect(api.runtime).toBe('20')
    expect(api.testCommand).toBe('npm test')
    expect(api.entryPoints).toEqual([
      'src/server.js (package.json main)',
      'npm start: `node src/server.js`',
      'src/server.js',
    ])
    expect(api.endpoints).toEqual([
      { method: 'GET', path: '/:id', file: 'src/routes/accounts.js', line: 6 },
      { method: 'POST', path: '/:id/deactivate', file: 'src/routes/accounts.js', line: 12 },
      { method: 'USE', path: '/api/accounts', file: 'src/server.js', line: 6 },
      { method: 'GET', path: '/health', file: 'src/server.js', line: 7 },
    ])
    expect(api.calls).toEqual([])
    expect(api.models).toEqual(['src/models/account.js'])
    expect(api.migrations).toEqual([['migrations', 1]])
    expect(api.sqlFiles).toEqual(['migrations/001-create-accounts.sql'])
    expect(api.configFiles).toEqual(['.env.example'])
    expect(api.tests).toEqual({ count: 1, dirs: ['test'] })
    expect(api.languages).toEqual([
      ['JavaScript', 4],
      ['SQL', 1],
    ])
    expect(api.structure).toEqual([
      ['migrations', 1],
      ['src', 1],
      ['src/models', 1],
      ['src/routes', 1],
      ['test', 1],
    ])
  })

  it('maps a front-end: screens and outgoing calls', () => {
    expect(web.runtime).toBe('14')
    expect(web.testCommand).toBe('npm test')
    expect(web.stack[0]).toMatch(/React \^16\.14\.0.*React Router.*axios/)
    expect(web.screens).toEqual([
      { method: 'SCREEN', path: '/accounts/:id', file: 'src/App.jsx', line: 9 },
    ])
    expect(web.calls).toEqual([
      { method: 'GET', path: '/api/accounts/${id}', file: 'src/api/accounts.js', line: 3 },
      {
        method: 'POST',
        path: '/api/accounts/${id}/deactivate',
        file: 'src/api/accounts.js',
        line: 5,
      },
    ])
  })

  it('connects front-end calls to back-end routes, through mounted routers', () => {
    const connections = findConnections([api, web])
    expect(
      connections.map((c) => [
        c.call.method,
        `${c.call.repo}:${c.call.file}:${c.call.line}`,
        `${c.endpoint.repo}:${c.endpoint.file}:${c.endpoint.line}`,
        c.via,
      ]),
    ).toEqual([
      ['GET', 'web:src/api/accounts.js:3', 'api:src/routes/accounts.js:6', '/api/accounts'],
      ['POST', 'web:src/api/accounts.js:5', 'api:src/routes/accounts.js:12', '/api/accounts'],
    ])
    expect(renderConnections([api, web], connections)).toContain(
      '- `GET /api/accounts/:param`: web src/api/accounts.js:3 → api src/routes/accounts.js:6 (mounted at `/api/accounts`)',
    )
  })

  it('renders a readable Markdown map', () => {
    const markdown = renderRepoMap(api)
    expect(markdown).toMatch(/^# Repository: api\n/)
    expect(markdown).toContain('fixes from `main`, features from `main`')
    expect(markdown).toContain('- `GET /:id` — src/routes/accounts.js:6')
    expect(markdown).toContain('- Runtime: Node 20')
    expect(markdown).toContain('1 test files in: test')
  })
})
