import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { knowledgeFeature } from '#src/features/knowledge/index.ts'
import { MAX_CONTENT_CHARS } from '#src/features/knowledge/save.tool.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

const today = new Date().toISOString().slice(0, 10)
const masking = { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true }

describe('knowledge_save MCP tool', () => {
  let root: string
  let knowledge: string
  let audit: InMemoryAuditLog
  const clients: Client[] = []

  const connect = async (writable: boolean | undefined) => {
    const server = createMcpServer({
      project: 'acme',
      tools: knowledgeFeature.tools,
      integrations: [],
      context: {
        tickets: null,
        databases: null,
        repos: null,
        knowledge: writable ? { dir: knowledge, writable: { masking } } : { dir: knowledge },
      },
      masking,
      audit,
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    clients.push(client)
    return client
  }
  const save = async (args: Record<string, unknown>) =>
    (await connect(true)).callTool({ name: 'knowledge_save', arguments: args })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ticketsmith-knowledge-save-'))
    knowledge = join(root, 'knowledge')
    await mkdir(knowledge, { recursive: true })
    audit = new InMemoryAuditLog()
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close()
    await rm(root, { recursive: true, force: true })
  })

  it('is only offered when the session allows writing knowledge', async () => {
    const names = async (writable: boolean | undefined) =>
      (await (await connect(writable)).listTools()).tools.map((tool) => tool.name)
    expect(await names(undefined)).not.toContain('knowledge_save')
    expect(await names(false)).not.toContain('knowledge_save')
    expect(await names(true)).toContain('knowledge_save')
  })

  it('asks the client, in the server instructions, to offer saving at the end', async () => {
    expect((await connect(true)).getInstructions()).toContain('offer the user to save')
    expect((await connect(false)).getInstructions()).not.toContain('knowledge_save')
  })

  it('saves a case under cases/<KEY>.md with front matter, masked', async () => {
    const result = await save({
      kind: 'case',
      ticket: 'OPS-123',
      type: 'service-request',
      content: '## Summary\n\nThe customer ana@gmail.com asked to update their plan.',
    })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Saved knowledge/cases/OPS-123.md')

    const file = await readFile(join(knowledge, 'cases', 'OPS-123.md'), 'utf8')
    expect(file).toBe(
      [
        '---',
        'ticket: OPS-123',
        'type: service-request',
        'savedBy: claude-code',
        `savedAt: ${today}`,
        '---',
        '',
        '# OPS-123: resolved case',
        '',
        '## Summary',
        '',
        'The customer [EMAIL_1] asked to update their plan.',
        '',
      ].join('\n'),
    )
  })

  it('keeps session placeholders as they are, never revealing them', async () => {
    await save({ kind: 'case', ticket: 'OPS-9', content: 'Account of [EMAIL_1]@northwind.mx.' })
    const file = await readFile(join(knowledge, 'cases', 'OPS-9.md'), 'utf8')
    expect(file).toContain('Account of [EMAIL_1]@northwind.mx.')
    expect(file).toContain('type: unclassified')
  })

  it('saves a note under notes/ with a safe slug', async () => {
    const result = await save({
      kind: 'note',
      topic: '../../Cómo se calculan las comisiones / pods',
      content: 'Commissions are computed nightly.',
    })
    expect(textOf(result)).toContain(
      'Saved knowledge/notes/como-se-calculan-las-comisiones-pods.md',
    )
    const file = await readFile(
      join(knowledge, 'notes', 'como-se-calculan-las-comisiones-pods.md'),
      'utf8',
    )
    expect(file).toContain('topic: ../../Cómo se calculan las comisiones / pods')
    expect(file).toContain('# ../../Cómo se calculan las comisiones / pods')
    expect(file).toContain('Commissions are computed nightly.')
  })

  it('appends an update to an existing file instead of overwriting it', async () => {
    await mkdir(join(knowledge, 'cases'))
    const original =
      '---\nticket: OPS-5\ntype: bug\n---\n\n# OPS-5: resolved case\n\nBy a person.\n'
    await writeFile(join(knowledge, 'cases', 'OPS-5.md'), original)

    await save({ kind: 'case', ticket: 'OPS-5', content: 'It happened again in production.' })
    const file = await readFile(join(knowledge, 'cases', 'OPS-5.md'), 'utf8')
    expect(file.startsWith(original)).toBe(true)
    expect(file).toContain(
      `\n## Update ${today} (Claude Code)\n\nIt happened again in production.\n`,
    )
  })

  it('refuses a cases/ or notes/ folder that points outside knowledge/', async () => {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(knowledge, 'cases'))
    const result = await save({ kind: 'case', ticket: 'OPS-1', content: 'x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the knowledge folder')
  })

  it('refuses a case file that is a symlink out of knowledge/', async () => {
    await mkdir(join(knowledge, 'cases'))
    await writeFile(join(root, 'outside.md'), 'keep me\n')
    await symlink(join(root, 'outside.md'), join(knowledge, 'cases', 'OPS-2.md'))
    const result = await save({ kind: 'case', ticket: 'OPS-2', content: 'x' })
    expect(result.isError).toBe(true)
    expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe('keep me\n')
  })

  it('validates what it needs for each kind', async () => {
    const noTicket = await save({ kind: 'case', content: 'x' })
    expect(noTicket.isError).toBe(true)
    expect(textOf(noTicket)).toContain('ticket')

    const badKey = await save({ kind: 'case', ticket: 'not a key', content: 'x' })
    expect(badKey.isError).toBe(true)

    const noTopic = await save({ kind: 'note', content: 'x' })
    expect(noTopic.isError).toBe(true)
    expect(textOf(noTopic)).toContain('topic')

    const punctuationOnly = await save({ kind: 'note', topic: '../..', content: 'x' })
    expect(punctuationOnly.isError).toBe(true)

    const tooLong = await save({
      kind: 'note',
      topic: 'big',
      content: 'x'.repeat(MAX_CONTENT_CHARS + 1),
    })
    expect(tooLong.isError).toBe(true)
  })

  it('audits the content by size only, never its text', async () => {
    await save({ kind: 'case', ticket: 'OPS-7', content: 'Customer ana@gmail.com, details.' })
    const entry = audit.entries.find((e) => e.tool === 'knowledge_save')
    expect(entry?.input).toEqual({ kind: 'case', ticket: 'OPS-7', content: { chars: 32 } })
    expect(JSON.stringify(audit.entries)).not.toContain('ana@gmail.com')
  })
})
