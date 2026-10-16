import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '#src/bootstrap/mcp-server.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import { ticketsFeature } from '#src/features/tickets/index.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const tickets = [
  makeTicket('OPS-1', {
    description: 'El cliente ana@acme.mx reporta cobro a la tarjeta 4111 1111 1111 1111.',
  }),
  makeTicket('OPS-2', { summary: 'Contactar a ana@acme.mx' }),
  makeTicket('OPS-3', { summary: 'Usuario luis@gmail.com y ana@acme.mx' }),
]

type TextContent = { type: 'text'; text: string }
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as TextContent[]).map((c) => c.text).join('')

describe('ticketsmith MCP server', () => {
  let client: Client
  let source: InMemoryTicketSource
  let audit: InMemoryAuditLog

  const connect = async (defaultJql: string | null = 'project = OPS') => {
    source = new InMemoryTicketSource(tickets)
    audit = new InMemoryAuditLog()
    let now = 1_000
    const server = createMcpServer({
      project: 'acme',
      tools: ticketsFeature.tools,
      integrations: ['tickets'],
      context: {
        tickets: { source, defaultJql: defaultJql ?? undefined },
        databases: null,
        repos: null,
        knowledge: { dir: '/nonexistent/knowledge' },
      },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit,
      version: '1.2.3',
      clock: () => (now += 5),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  }

  beforeEach(() => connect())
  afterEach(() => client.close())

  it('exposes only read-only tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['jira_get_issue', 'jira_search'])
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }
    expect(client.getInstructions()).toContain('[EMAIL_1]')
  })

  it('returns a masked ticket and audits a summary without content', async () => {
    const result = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'ops-1' } })
    const text = textOf(result)

    expect(result.isError).toBeFalsy()
    expect(text).toContain('# OPS-1: Summary of OPS-1')
    expect(text).toContain('El cliente [EMAIL_1]@acme.mx reporta cobro a la tarjeta [CARD_1].')
    expect(text).not.toContain('ana@acme.mx')

    expect(audit.entries).toEqual([
      {
        tool: 'jira_get_issue',
        input: { key: 'ops-1' },
        ok: true,
        durationMs: 5,
        output: { chars: text.length, masked: { email: 1, card: 1 } },
      },
    ])
    expect(JSON.stringify(audit.entries)).not.toContain('reporta cobro')
  })

  it('reports errors as tool errors and audits them', async () => {
    const missing = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-99' } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toMatch(/Not found: OPS-99/)

    const invalid = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'nope' } })
    expect(textOf(invalid)).toMatch(/Invalid ticket key/)
    expect(audit.entries.map((e) => [e.ok, e.error?.slice(0, 13)])).toEqual([
      [false, 'Not found: OP'],
      [false, 'Invalid ticke'],
    ])
  })

  it('searches with the profile JQL by default and masks summaries', async () => {
    const result = await client.callTool({ name: 'jira_search', arguments: {} })
    expect(source.queries).toEqual([{ query: 'project = OPS', limit: 20 }])
    expect(textOf(result)).toContain(
      '- **OPS-2** · Bug · To Do · High · Unassigned: Contactar a [EMAIL_1]',
    )
  })

  it('keeps placeholders consistent across calls in a session', async () => {
    const first = textOf(
      await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-1' } }),
    )
    const third = textOf(
      await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-3' } }),
    )
    expect(first).toContain('[EMAIL_1]@acme.mx')
    expect(third).toContain('Usuario [EMAIL_2] y [EMAIL_1]@acme.mx')
  })

  it('resolves placeholders in JQL server-side without exposing or auditing real values', async () => {
    await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-1' } })
    const jql = 'text ~ "[EMAIL_1]@acme.mx"'
    const result = await client.callTool({ name: 'jira_search', arguments: { jql } })

    expect(source.queries).toEqual([{ query: 'text ~ "ana@acme.mx"', limit: 20 }])
    expect(textOf(result)).toContain(`for JQL: ${jql}`)
    expect(textOf(result)).not.toContain('ana@acme.mx')
    expect(JSON.stringify(audit.entries)).not.toContain('ana@acme.mx')
  })

  it('refuses placeholders it never issued instead of sending them to JIRA', async () => {
    const result = await client.callTool({
      name: 'jira_search',
      arguments: { jql: 'text ~ "[EMAIL_9]"' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Unknown placeholder\(s\) \[EMAIL_9\]/)
    expect(source.queries).toEqual([])
  })

  it('uses the given JQL and limit', async () => {
    await client.callTool({
      name: 'jira_search',
      arguments: { jql: 'assignee = currentUser()', limit: 5 },
    })
    expect(source.queries).toEqual([{ query: 'assignee = currentUser()', limit: 5 }])
  })

  it('rejects limits out of range before calling JIRA', async () => {
    const result = await client.callTool({ name: 'jira_search', arguments: { limit: 500 } })
    expect(result.isError).toBe(true)
    expect(source.queries).toEqual([])
  })

  it('explains how to fix a missing JQL', async () => {
    await client.close()
    await connect(null)
    const result = await client.callTool({ name: 'jira_search', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/ticketsmith jira discover/)
  })
})

describe('ticketsmith MCP server without a ticket source', () => {
  it('does not register tools that need integrations the project lacks', async () => {
    const server = createMcpServer({
      project: 'repos-only',
      tools: ticketsFeature.tools,
      integrations: [],
      context: {
        tickets: null,
        databases: null,
        repos: null,
        knowledge: { dir: '/nonexistent/knowledge' },
      },
      masking: { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true },
      audit: new InMemoryAuditLog(),
      version: '1.2.3',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools().catch(() => ({ tools: [] }))
    expect(listed.tools).toEqual([])
    await client.close()
  })
})
