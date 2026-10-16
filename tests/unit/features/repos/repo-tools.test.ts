import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import { isToolAvailable } from '#src/core/mcp/index.ts'
import { cloneRepository, type Repository } from '#src/core/repos/index.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { reposFeature } from '#src/features/repos/index.ts'
import { testRepository } from '#tests/support/fake-cli.ts'
import { TestRemote } from '#tests/support/git-repos.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

// Built at runtime so no scanner flags the fixture as a leaked key.
const STRIPE_KEY = ['sk', 'live', '51HxAcmeFakeKey000000000000'].join('_')

describe('repository MCP tools', () => {
  const remotes: TestRemote[] = []
  let work: string
  let client: Client
  let audit: InMemoryAuditLog

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ticketsmith-repo-tools-'))
    const api = new TestRemote({
      fixture: 'api-express',
      files: {
        '.gitignore': '.env\n',
        '.env': 'DB_PASSWORD=hunter2\n',
        'src/billing.js': `const stripe = require('stripe')('${STRIPE_KEY}')\nconst SUPPORT = 'soporte@northwind.mx'\n`,
        'docs/outside': { symlink: '/etc/hosts' },
        'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        'big.txt': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'),
      },
    })
    api.branch('develop')
    api.commit({ 'src/routes/accounts.js': '// rewritten on main only\n' }, 'main moves on')
    const web = new TestRemote({ fixture: 'web-react' })
    remotes.push(api, web)

    const repositories: Repository[] = [
      { config: testRepository('api', { url: api.url }), dir: join(work, 'api') },
      { config: testRepository('web', { url: web.url }), dir: join(work, 'web') },
      { config: testRepository('docs'), dir: join(work, 'docs') }, // never cloned
    ]
    for (const repository of repositories.slice(0, 2)) {
      const cloned = await cloneRepository(repository.config.url, repository.dir)
      if (!cloned.ok) throw new Error(cloned.error)
    }

    audit = new InMemoryAuditLog()
    const server = createMcpServer({
      project: 'acme',
      tools: reposFeature.tools,
      integrations: ['repos'],
      context: {
        tickets: null,
        databases: null,
        repos: { repositories, knowledgeDir: join(work, 'knowledge') },
        knowledge: { dir: join(work, 'knowledge') },
      },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit,
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterAll(async () => {
    await client.close()
    for (const remote of remotes) remote[Symbol.dispose]()
    rmSync(work, { recursive: true, force: true })
  })

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args })

  it('registers the four read-only tools only for projects with repositories', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'repo_list',
      'repo_files',
      'repo_search',
      'repo_read',
    ])
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)

    expect(reposFeature.tools.some((tool) => isToolAvailable(tool, ['tickets', 'databases']))).toBe(
      false,
    )
  })

  it('lists the repositories with their clone state and map', async () => {
    const text = textOf(await call('repo_list'))
    expect(text).toContain('## api')
    expect(text).toMatch(/Clone: main at [0-9a-f]{12}/)
    expect(text).toContain('- Map: knowledge/repos/api.md')
    expect(text).toContain('## docs\n- URL: git@git.acme.dev:acme/docs.git')
    expect(text).toContain('not cloned yet (run `ticketsmith project refresh repos`)')
  })

  it('lists tracked files by folder and glob, never ignored ones', async () => {
    const routes = textOf(await call('repo_files', { repo: 'api', path: 'src/routes' }))
    expect(routes).toContain('src/routes/accounts.js')
    const sql = textOf(await call('repo_files', { repo: 'api', glob: '*.sql' }))
    expect(sql).toMatch(
      /1 files in api at main \([0-9a-f]{7}\):\n\nmigrations\/001-create-accounts\.sql$/,
    )
    const all = textOf(await call('repo_files', { repo: 'api' }))
    expect(all).not.toContain('.env\n')
    expect(all).toContain('.env.example')
  })

  it('searches one or every repository and reports file:line', async () => {
    const one = textOf(await call('repo_search', { repo: 'web', pattern: 'axios.get' }))
    expect(one).toContain('web:src/api/accounts.js:3: export const getAccount')

    const every = textOf(await call('repo_search', { pattern: 'accounts', path: 'src' }))
    expect(every).toMatch(/^\d+ matches for "accounts"/)
    expect(every).toContain('api:src/server.js:2:')
    expect(every).toContain('web:src/api/accounts.js:3:')
    expect(every).toContain('docs: Repository "docs" is not cloned yet')

    const regex = textOf(
      await call('repo_search', {
        repo: 'api',
        pattern: 'router\\.(get|post)',
        regex: true,
        ref: 'develop',
      }),
    )
    expect(regex).toContain('api:src/routes/accounts.js:6:')

    const limited = textOf(
      await call('repo_search', { repo: 'api', pattern: 'line', maxResults: 3 }),
    )
    expect(limited).toMatch(/showing 3; narrow with repo or path/)
  })

  it('reads files with line numbers and ranges, at any ref', async () => {
    const head = textOf(await call('repo_read', { repo: 'api', path: 'src/routes/accounts.js' }))
    expect(head).toContain('// rewritten on main only')

    const develop = textOf(
      await call('repo_read', {
        repo: 'api',
        path: 'src/routes/accounts.js',
        ref: 'develop',
        startLine: 6,
        endLine: 7,
      }),
    )
    expect(develop).toMatch(
      /^api\/src\/routes\/accounts\.js at develop \([0-9a-f]{7}\), lines 6-7 of 17:/,
    )
    expect(develop).toContain("6  router.get('/:id', async (req, res) => {")

    const big = textOf(await call('repo_read', { repo: 'api', path: 'big.txt' }))
    expect(big).toContain('lines 1-400 of 1000')
    expect(big).toContain('(600 more lines: continue with startLine 401)')
  })

  it('keeps reads inside the tracked tree', async () => {
    const attempts: Array<[Record<string, unknown>, RegExp]> = [
      [{ repo: 'api', path: '../../etc/passwd' }, /Invalid path/],
      [{ repo: 'api', path: '/etc/passwd' }, /Invalid path/],
      [{ repo: 'api', path: '.env' }, /No tracked file "\.env"/],
      [{ repo: 'api', path: '.git/config' }, /No tracked file/],
      [{ repo: 'api', path: 'src' }, /is a directory/],
      [{ repo: 'api', path: 'assets/logo.png' }, /binary file \(6 bytes\)/],
      [{ repo: 'api', path: 'README', ref: '--output=/tmp/pwned' }, /Invalid ref/],
      [{ repo: 'api', path: 'README', ref: 'main..develop' }, /Invalid ref/],
      [{ repo: 'nope', path: 'x' }, /Unknown repository "nope"/],
    ]
    for (const [args, message] of attempts) {
      const result = await call('repo_read', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(textOf(result)).toMatch(message)
    }
    const link = textOf(await call('repo_read', { repo: 'api', path: 'docs/outside' }))
    expect(link).toContain('1  /etc/hosts')
    expect(link).not.toContain('localhost')
  })

  it('masks secrets and personal data found in code, and audits without content', async () => {
    const text = textOf(await call('repo_read', { repo: 'api', path: 'src/billing.js' }))
    expect(text).not.toContain(STRIPE_KEY)
    expect(text).not.toContain('soporte@northwind.mx')
    expect(text).toContain('@northwind.mx')

    const search = textOf(await call('repo_search', { repo: 'api', pattern: 'stripe' }))
    expect(search).not.toContain(STRIPE_KEY)
    expect(JSON.stringify(audit.entries)).not.toContain(STRIPE_KEY)
  })
})
