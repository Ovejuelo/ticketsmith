import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { knowledgeFeature } from '#src/features/knowledge/index.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

describe('knowledge MCP tools', () => {
  let root: string
  let client: Client

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ticketsmith-knowledge-'))
    const knowledge = join(root, 'knowledge')
    await mkdir(join(knowledge, 'repos'), { recursive: true })
    await writeFile(join(knowledge, 'brief.md'), '# Brief\n\nSee repos/api.md for the API.\n')
    await writeFile(
      join(knowledge, 'repos', 'api.md'),
      Array.from({ length: 700 }, (_, i) =>
        i === 41 ? 'GET /api/accounts/:id' : `line ${i + 1}`,
      ).join('\n'),
    )
    await writeFile(join(knowledge, 'notes.txt'), 'not markdown\n')
    await writeFile(join(root, 'outside.md'), 'secret plans\n')
    await symlink(join(root, 'outside.md'), join(knowledge, 'escape.md'))

    const server = createMcpServer({
      project: 'acme',
      tools: knowledgeFeature.tools,
      integrations: [],
      context: { tickets: null, databases: null, repos: null, knowledge: { dir: knowledge } },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit: new InMemoryAuditLog(),
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })
  afterAll(async () => {
    await client.close()
    await rm(root, { recursive: true, force: true })
  })

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args })

  it('is available to every project, even without integrations', async () => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'knowledge_read',
      'knowledge_search',
    ])
  })

  it('reads files whole or by line range', async () => {
    expect(textOf(await call('knowledge_read', { path: 'brief.md' }))).toBe(
      '# Brief\n\nSee repos/api.md for the API.',
    )
    const first = textOf(await call('knowledge_read', { path: 'repos/api.md' }))
    expect(first).toMatch(/^repos\/api\.md, lines 1-500 of 700:/)
    expect(first).toContain('(200 more lines: continue with startLine 501)')
    expect(textOf(await call('knowledge_read', { path: 'repos/api.md', startLine: 690 }))).toMatch(
      /^repos\/api\.md, lines 690-700 of 700:\n\nline 690/,
    )
  })

  it('searches every file with file:line', async () => {
    const found = textOf(await call('knowledge_search', { query: 'API/accounts' }))
    expect(found).toBe('1 matches for "API/accounts":\n\nrepos/api.md:42: GET /api/accounts/:id')
    expect(textOf(await call('knowledge_search', { query: 'secret plans' }))).toMatch(/^No matches/)
  })

  it('never reads outside the knowledge folder or non-Markdown files', async () => {
    for (const path of ['../outside.md', '/etc/passwd', 'notes.txt', 'escape.md', 'missing.md']) {
      const result = await call('knowledge_read', { path })
      expect(result.isError, path).toBe(true)
    }
    expect(textOf(await call('knowledge_read', { path: 'escape.md' }))).toMatch(
      /outside the knowledge folder/,
    )
  })
})
