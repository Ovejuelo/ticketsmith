import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest } from '#src/core/agent/index.ts'
import { openProject } from '#src/core/cli/index.ts'
import type { ProjectPaths } from '#src/core/project/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const TICKET_TYPES = `---
threshold: 0.75
types:
  - name: bug
    description: Something fails
    playbook: bug
    match: { issueTypes: [Incident], keywords: [error, falla] }
  - name: service-request
    description: A data change
    playbook: service-request
    match: { issueTypes: [Service request], keywords: [desactivar, corregir] }
  - name: new-functionality
    description: Something new
    route: feature
    match: { issueTypes: [New Functionality], keywords: [nueva funcionalidad] }
---
`

describe('ticketsmith classify', () => {
  let cli: FakeCli
  let paths: ProjectPaths

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-1', {
        type: 'Incident',
        summary: 'Error al cobrar',
        description: 'Falla en el pago',
      }),
      makeTicket('OPS-2', {
        type: 'Service request',
        summary: 'Activar cobro automático',
        description: '',
      }),
      makeTicket('OPS-3', {
        type: 'New Functionality',
        summary: 'Nueva funcionalidad de reportes',
        description: '',
      }),
    ])
    paths = (await openProject(cli.services, undefined)).paths
    await mkdir(paths.knowledgeDir, { recursive: true })
    await writeFile(join(paths.knowledgeDir, 'ticket-types.md'), TICKET_TYPES)
  })
  afterEach(() => cli.cleanup())

  it('decides with the rules alone when they are sure, for free', async () => {
    expect(await cli.run('classify', 'ops-1')).toBeNull()
    expect(cli.agent.requests).toEqual([])
    expect(cli.stdout).toContain('OPS-1: bug (0.8, by rules)')
    expect(cli.stdout).toContain('Next: ticketsmith process OPS-1 --playbook bug')
    const saved = JSON.parse(
      await readFile(join(paths.outDir, 'OPS-1', 'classification.json'), 'utf8'),
    )
    expect(saved).toMatchObject({
      ticket: 'OPS-1',
      type: 'bug',
      source: 'rules',
      route: 'process',
      playbook: 'bug',
    })
  })

  it('asks the LLM when the rules are unsure, with read-only tools and the rules hint', async () => {
    let offered: string[] = []
    cli.agent.reply(async (request: AgentRequest) => {
      const config = request.mcpConfig.mcpServers['ticketsmith'] as {
        url: string
        headers: Record<string, string>
      }
      const client = new Client({ name: 'fake', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        }) as Transport,
      )
      offered = (await client.listTools()).tools.map((tool) => tool.name)
      await client.close()
      return {
        type: 'new-functionality',
        confidence: 0.9,
        reason: 'Asks to enable a new automatic charge.',
      }
    })

    expect(await cli.run('classify', 'OPS-2')).toBeNull()

    expect(offered.sort()).toEqual(['jira_get_issue', 'knowledge_read', 'knowledge_search'])
    const [request] = cli.agent.requests
    expect(request?.playbook).toMatch(/^# Playbook: classify a ticket/)
    expect(request?.prompt).toContain('The rules suggest service-request (0.6)')
    expect(request?.prompt).toContain('- new-functionality: Something new')
    expect(request?.maxBudgetUsd).toBe(0.3)
    expect(cli.stdout).toContain('OPS-2: new-functionality (0.9, by llm')
    expect(cli.stdout).toContain('Next: ticketsmith feature OPS-2')
  })

  it('stops without a terminal when both are unsure', async () => {
    cli.agent.reply({ type: 'service-request', confidence: 0.5, reason: 'Unclear.' })
    expect((await cli.run('classify', 'OPS-2'))?.message).toMatch(
      /Ambiguous classification of OPS-2 \(0\.5 service-request; rules: 0\.6 service-request\)\. Run `ticketsmith classify OPS-2`/,
    )
  })

  it('makes process follow the classification, and never start code changes by itself', async () => {
    cli.agent.reply({
      summary: 'x',
      ticketType: 'bug',
      probableCause: 'y',
      confidence: 'high',
      evidence: [],
      nextSteps: [],
      openQuestions: [],
      jiraComment: 'z',
    })
    expect(await cli.run('process', 'OPS-1')).toBeNull()
    expect(cli.agent.requests.at(-1)?.playbook).toMatch(/^# Playbook: investigate a ticket/)
    expect(cli.stderr).toContain('Classified as bug (0.8, by rules)')

    // OPS-3 scores 0.7 on rules (under 0.75): the LLM confirms, and process stops there.
    cli.agent.reply({
      type: 'new-functionality',
      confidence: 0.95,
      reason: 'Asks for new reports.',
    })
    const before = cli.agent.requests.length
    expect(await cli.run('process', 'OPS-3')).toBeNull()
    expect(cli.agent.requests).toHaveLength(before + 1)
    expect(cli.agent.requests.at(-1)?.playbook).toMatch(/^# Playbook: classify a ticket/)
    expect(cli.stdout).toContain(
      'OPS-3 is new-functionality: that changes code, which you start yourself with `ticketsmith feature OPS-3`',
    )
  })
})
