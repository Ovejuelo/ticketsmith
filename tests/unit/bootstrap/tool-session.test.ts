import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openToolSession, startHttpToolServer } from '#src/bootstrap/tool-session.ts'
import type { AgentToolServer } from '#src/core/cli/index.ts'
import { openProject } from '#src/core/cli/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

type TextContent = { type: 'text'; text: string }

describe('HTTP tool server for agent runs', () => {
  let cli: FakeCli
  let server: AgentToolServer
  const clients: Client[] = []

  const start = async (only?: (name: string) => boolean) => {
    const opened = await openProject(cli.services, undefined)
    return startHttpToolServer(
      await openToolSession(cli.services, opened, {
        version: '1.2.3',
        auditCommand: 'process',
        only,
      }),
    )
  }
  const endpoint = (s: AgentToolServer) => {
    const config = s.mcpConfig.mcpServers['ticketsmith'] as {
      type: string
      url: string
      headers: Record<string, string>
    }
    return config
  }
  const connect = async (s: AgentToolServer, headers = endpoint(s).headers) => {
    const client = new Client({ name: 'agent', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint(s).url), {
      requestInit: { headers },
    })
    // The SDK's transport class predates exactOptionalPropertyTypes; it is a Transport at runtime.
    await client.connect(transport as Transport)
    clients.push(client)
    return client
  }

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject())
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-1', {
        description:
          'Customer ana@northwind.mx cannot pay. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    ])
    server = await start()
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {})
    await server.close()
    await cli.cleanup()
  })

  it('serves the tools on 127.0.0.1 with a per-run bearer token', async () => {
    const config = endpoint(server)
    expect(config.type).toBe('http')
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(config.headers['Authorization']).toMatch(/^Bearer [0-9a-f]{64}$/)

    const client = await connect(server)
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toEqual(
      expect.arrayContaining(['jira_get_issue', 'jira_search', 'knowledge_read']),
    )
    expect(tools).not.toContain('db_select')
  })

  it('rejects requests without the token, with a wrong one, or for another host', async () => {
    const { url } = endpoint(server)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body,
      })
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
    // fetch drops a custom Host header; node:http sends it as given.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const target = new URL(url)
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            ...endpoint(server).headers,
            Host: 'evil.example',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end(body)
    })
    expect(hostStatus).toBe(403)
    expect((await fetch(url.replace('/mcp', '/other'))).status).toBe(404)
  })

  it('masks for the agent and reveals for local files with the same vault, secrets excepted', async () => {
    const client = await connect(server)
    const result = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-1' } })
    const text = (result.content as TextContent[]).map((c) => c.text).join('')
    expect(text).toContain('[EMAIL_1]@northwind.mx')
    expect(text).not.toContain('ana@northwind.mx')

    expect(server.reveal('Write to [EMAIL_1]@northwind.mx; token [SECRET_1]')).toBe(
      'Write to ana@northwind.mx; token [SECRET_1]',
    )
    expect(server.toolCalls()).toEqual({ jira_get_issue: 1 })
  })

  it('offers only the selected tools when asked', async () => {
    const limited = await start((name) => name.startsWith('knowledge_'))
    try {
      const client = await connect(limited)
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'knowledge_read',
        'knowledge_search',
      ])
    } finally {
      await limited.close()
    }
  })

  it('frees the port when closed', async () => {
    const { url, headers } = endpoint(server)
    await server.close()
    await expect(fetch(url, { method: 'POST', headers })).rejects.toThrow()
    server = await start() // afterEach closes this one
  })
})
