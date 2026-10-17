import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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

const TYPES = `---
threshold: 0.75
types:
  - name: bug
    playbook: bug
    match: { issueTypes: [Incident], keywords: [error, falla] }
  - name: service-request
    playbook: service-request
    match: { issueTypes: [Service request], keywords: [desactivar, corregir] }
---
`

type TextContent = { type: 'text'; text: string }

/** Like Claude: reads the ticket through the tools, then answers. */
const readsTicket = (seen: string[], answer: unknown) => async (request: AgentRequest) => {
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
  const key = /ticket (OPS-\d+)/i.exec(request.prompt)?.[1] ?? ''
  const result = await client.callTool({ name: 'jira_get_issue', arguments: { key } })
  seen.push((result.content as TextContent[]).map((c) => c.text).join(''))
  await client.close()
  return answer
}

describe('ticketsmith eval', () => {
  let cli: FakeCli
  let paths: ProjectPaths

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject({ projectKey: 'OPS' }))
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-1', {
        type: 'Incident',
        summary: 'Error al cobrar',
        description: 'Falla con ana@northwind.mx',
      }),
      makeTicket('OPS-2', {
        type: 'Service request',
        summary: 'Activar cobro automático',
        description: 'Pide luis@contoso.mx',
      }),
    ])
    paths = (await openProject(cli.services, undefined)).paths
    await mkdir(paths.knowledgeDir, { recursive: true })
    await writeFile(join(paths.knowledgeDir, 'ticket-types.md'), TYPES)
    await mkdir(join(paths.outDir, 'OPS-1'), { recursive: true })
    await writeFile(
      join(paths.outDir, 'OPS-1', 'classification.json'),
      JSON.stringify({ type: 'bug' }),
    )
  })
  afterEach(() => cli.cleanup())

  const addBoth = async () => {
    expect(
      await cli.run(
        'eval',
        'add',
        'ops-1',
        '--solution',
        'Cards of ana@northwind.mx were expired.',
      ),
    ).toBeNull()
    expect(
      await cli.run(
        'eval',
        'add',
        'OPS-2',
        '--expected-type',
        'service-request',
        '--solution',
        'Enabled it.',
      ),
    ).toBeNull()
    cli.source = new InMemoryTicketSource([]) // evals must not need the real source any more
  }

  it('stores a masked snapshot with the expected type and the solution', async () => {
    await addBoth()
    const text = await readFile(join(paths.evalsDir, 'OPS-1.yaml'), 'utf8')
    expect(text).toContain('expectedType: bug')
    expect(text).toContain('[EMAIL_1]@northwind.mx')
    expect(text).not.toContain('ana@northwind.mx')
    expect(text).toMatch(/solution: Cards of \[EMAIL_1\]@northwind\.mx were expired\./)
    expect((await cli.run('eval', 'add', 'OPS-2'))?.message).toMatch(/Pass --expected-type/)
  })

  it('classifies every case from its snapshot and reports accuracy, mistakes and regressions', async () => {
    await addBoth()
    const seen: string[] = []
    cli.agent.reply(readsTicket(seen, { type: 'bug', confidence: 0.9, reason: 'Looks broken.' }))

    expect((await cli.run('eval'))?.message).toBeUndefined()
    expect(seen).toHaveLength(1) // OPS-1 by rules; OPS-2 needed the LLM
    expect(seen[0]).toContain('Pide [EMAIL_1]@contoso.mx') // served from the masked snapshot
    expect(cli.stdout).toContain('Classification: 1/2 right (50%); 1 decided by the rules alone.')
    expect(cli.stdout).toContain('service-request → bug: 1')
    expect(cli.stdout).toContain('No regressions against the previous run.')
    expect(await readdir(paths.evalRunsDir)).toHaveLength(1)

    // OPS-1 now loses its rule signals: it regresses and the command fails.
    await writeFile(
      join(paths.knowledgeDir, 'ticket-types.md'),
      TYPES.replace('issueTypes: [Incident], keywords: [error, falla]', 'issueTypes: [Bug]'),
    )
    cli.agent.reply({ type: 'service-request', confidence: 0.9, reason: 'Hmm.' })
    expect((await cli.run('eval'))?.message).toMatch(/1 regression\(s\)/)
    expect(cli.stdout).toContain('OPS-1: now service-request, was bug (expected bug)')
  })

  it('with --full runs the playbook and a judge, within the budget', async () => {
    await addBoth()
    const analysis = {
      summary: 's',
      ticketType: 'bug',
      probableCause: 'Expired cards.',
      confidence: 'high',
      evidence: [],
      nextSteps: [],
      openQuestions: [],
      jiraComment: 'c',
    }
    cli.agent.reply(
      analysis, // OPS-1 (rules) → playbook run
      { score: 5, reasoning: 'Same cause.' }, // judge
      { type: 'service-request', confidence: 0.9, reason: 'A request.' }, // OPS-2 classification
    )
    expect((await cli.run('eval', '--full', '--budget', '0.4'))?.message).toBeUndefined()
    const judgeRequest = cli.agent.requests[1]
    expect(judgeRequest?.playbook).toMatch(/^# Playbook: judge an answer/)
    expect(judgeRequest?.prompt).toContain(
      'How it was really solved:\nCards of [EMAIL_1]@northwind.mx were expired.',
    )
    expect(cli.stdout).toContain('Judged answers: average 5.0/5 over 1')
    expect(cli.stdout).toContain('OPS-2: skipped: the eval budget is spent')
  })
})
