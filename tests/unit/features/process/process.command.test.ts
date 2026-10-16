import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest, TicketAnalysis } from '#src/core/agent/index.ts'
import type { ProjectPaths } from '#src/core/project/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

type TextContent = { type: 'text'; text: string }

const analysis = (overrides: Partial<TicketAnalysis> = {}): TicketAnalysis => ({
  summary: 'The customer [EMAIL_1]@northwind.mx cannot pay because the card was declined.',
  ticketType: 'bug',
  probableCause: 'The payment gateway rejects expired cards; the account still has the old one.',
  confidence: 'medium',
  evidence: [
    { source: 'ticket', reference: 'description', finding: 'Reported by [EMAIL_1]@northwind.mx' },
    {
      source: 'code',
      reference: 'api/src/payments.js:42',
      finding: 'Expired cards are not refreshed',
    },
  ],
  nextSteps: ['Ask the customer to update the card', 'Add a refresh job'],
  openQuestions: ['Since when?'],
  jiraComment:
    'Hola, revisamos la cuenta de [EMAIL_1]@northwind.mx: la tarjeta está vencida. Token [SECRET_1].',
  ...overrides,
})

/** A fake agent that, like Claude, reads the ticket through the MCP server it was given. */
const readsTicketThenAnswers = (answer: TicketAnalysis) => async (request: AgentRequest) => {
  const config = request.mcpConfig.mcpServers['ticketsmith'] as {
    url: string
    headers: Record<string, string>
  }
  const client = new Client({ name: 'fake-agent', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  })
  await client.connect(transport as Transport)
  const ticket = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'OPS-7' } })
  const text = (ticket.content as TextContent[]).map((c) => c.text).join('')
  await client.close()
  if (text.includes('ana@northwind.mx') || text.includes('ghp_'))
    throw new Error('agent saw real data')
  return answer
}

describe('ticketsmith process', () => {
  let cli: FakeCli
  let paths: ProjectPaths

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-7', {
        description:
          'ana@northwind.mx cannot pay. Debug token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      }),
      makeTicket('OPS-8'),
    ])
    const located = await cli.services.projects.locate('acme')
    if (!located.ok) throw new Error('missing')
    paths = located.value
  })
  afterEach(() => cli.cleanup())

  const out = (key: string, file: string) => readFile(join(paths.outDir, key, file), 'utf8')

  it('investigates through masked tools and writes the analysis with real values back', async () => {
    cli.agent.reply(readsTicketThenAnswers(analysis()))

    expect(await cli.run('process', 'ops-7')).toBeNull()

    const [request] = cli.agent.requests
    expect(request?.prompt).toContain('Investigate ticket OPS-7 of the project "acme"')
    expect(request?.prompt).toContain('This project has: tickets.')
    expect(request?.playbook).toMatch(/^# Playbook: investigate a ticket/)
    expect(request?.maxBudgetUsd).toBe(3)
    expect(request?.timeoutMs).toBe(20 * 60_000)
    expect(JSON.stringify(request)).not.toContain('ana@northwind.mx')

    const report = await out('OPS-7', 'analysis.md')
    expect(report).toContain('# OPS-7: analysis')
    expect(report).toContain('The customer ana@northwind.mx cannot pay')
    expect(report).toContain('**code** `api/src/payments.js:42`: Expired cards are not refreshed')
    expect(report).toContain('1. Ask the customer to update the card')
    expect(await out('OPS-7', 'jira_comment.md')).toBe(
      'Hola, revisamos la cuenta de ana@northwind.mx: la tarjeta está vencida. Token [SECRET_1].\n',
    )
    expect(await out('OPS-7', 'ticket.md')).toContain('ana@northwind.mx cannot pay')

    const record = JSON.parse(await out('OPS-7', 'run.json'))
    expect(record).toMatchObject({
      ticket: 'OPS-7',
      playbook: { name: 'bug', source: 'built-in' },
      costUsd: 0.25,
      turns: 5,
      attempts: 1,
      toolCalls: { jira_get_issue: 1 },
      confidence: 'medium',
    })
    expect(JSON.stringify(record)).not.toContain('northwind')

    const audited = cli.audit.entries.map((entry) => entry.tool)
    expect(audited).toEqual(['jira_get_issue', 'agent_run'])
    expect(JSON.stringify(cli.audit.entries)).not.toContain('ana@northwind.mx')

    expect(cli.stdout).toContain('OPS-7: The customer ana@northwind.mx cannot pay')
    expect(cli.stdout).toContain('Run:           $0.25 · 5 turns')
    expect(cli.stderr).toContain(
      'Investigating OPS-7 with Claude (playbook bug, budget $3.00, up to 20 min)',
    )
  })

  it('retries an invalid answer once, then reports it', async () => {
    cli.agent.reply({ summary: 'incomplete' }, analysis())
    expect(await cli.run('process', 'OPS-7')).toBeNull()
    expect(JSON.parse(await out('OPS-7', 'run.json')).attempts).toBe(2)

    cli.agent.reply({ summary: 'still incomplete' })
    expect((await cli.run('process', 'OPS-8'))?.message).toMatch(/did not have the expected shape/)
    expect(existsSync(join(paths.outDir, 'OPS-8'))).toBe(false)
  })

  it('uses the project playbook, model and budget overrides', async () => {
    await mkdir(join(paths.knowledgeDir, 'playbooks'), { recursive: true })
    await writeFile(join(paths.knowledgeDir, 'playbooks', 'refund.md'), '# Refunds playbook\n')
    cli.agent.reply(analysis())

    expect(
      await cli.run(
        'process',
        'OPS-7',
        '--playbook',
        'refund',
        '--model',
        'sonnet',
        '--budget',
        '1.5',
      ),
    ).toBeNull()
    expect(cli.agent.requests[0]).toMatchObject({
      playbook: '# Refunds playbook\n',
      model: 'sonnet',
      maxBudgetUsd: 1.5,
    })
    expect(JSON.parse(await out('OPS-7', 'run.json')).playbook).toEqual({
      name: 'refund',
      source: 'project',
    })
  })

  it('picks the next ticket without an analysis', async () => {
    cli.agent.reply(analysis())
    expect(await cli.run('process', '--next')).toBeNull()
    expect(existsSync(join(paths.outDir, 'OPS-7', 'analysis.md'))).toBe(true)

    expect(await cli.run('process', '--next')).toBeNull()
    expect(existsSync(join(paths.outDir, 'OPS-8', 'analysis.md'))).toBe(true)

    expect(await cli.run('process', '--next')).toBeNull()
    expect(cli.stdout).toContain('Every ticket of the project JQL already has an analysis.')
  })

  it('explains agent failures and missing prerequisites', async () => {
    cli.agent.reply({ kind: 'not-installed' })
    expect((await cli.run('process', 'OPS-7'))?.message).toMatch(
      /npm i -g @anthropic-ai\/claude-code/,
    )
    expect(cli.audit.entries.at(-1)).toMatchObject({ tool: 'agent_run', ok: false })

    cli.agent.reply({ kind: 'budget-exceeded', costUsd: 3.2 })
    expect((await cli.run('process', 'OPS-7'))?.message).toMatch(/\$3\.20 spent/)

    expect((await cli.run('process'))?.message).toMatch(/ticket key or --next/)
    expect((await cli.run('process', 'OPS-7', '--budget', 'lots'))?.message).toMatch(
      /Invalid --budget/,
    )
    expect((await cli.run('process', 'OPS-404'))?.message).toMatch(/OPS-404/)

    await cli.withProject(testProject(null))
    expect((await cli.run('process', 'OPS-7'))?.message).toMatch(/project add tickets/)
  })
})
