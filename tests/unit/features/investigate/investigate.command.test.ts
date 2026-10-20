import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest, Investigation } from '#src/core/agent/index.ts'
import type { ProjectPaths } from '#src/core/project/index.ts'
import {
  FakeCli,
  testDatabase,
  testProject,
  testRepository,
  withDatabases,
  withRepositories,
} from '#tests/support/fake-cli.ts'

const investigation = (overrides: Partial<Investigation> = {}): Investigation => ({
  summary: 'Invoices for [EMAIL_1]@northwind.mx are generated twice when the job retries.',
  findings: [
    {
      title: 'Typo in a log message',
      severity: 'info',
      confidence: 'high',
      evidence: [{ source: 'code', reference: 'api/src/log.js:3', finding: 'Says "invioce"' }],
      suggestion: 'Fix the wording',
    },
    {
      title: 'The invoice job is not idempotent',
      severity: 'high',
      confidence: 'medium',
      evidence: [
        {
          source: 'code',
          reference: 'api/src/jobs/invoices.js:58',
          finding: 'Retries insert again without checking the period. Token [SECRET_1].',
        },
      ],
      suggestion: 'Add a unique key on (account, period)',
    },
  ],
  nextSteps: ['Add the unique key'],
  openQuestions: [],
  ...overrides,
})

const QUESTION = ['why', 'does', 'ana@northwind.mx', 'get', 'two', 'invoices?']

describe('ticketsmith investigate', () => {
  let cli: FakeCli
  let paths: ProjectPaths
  let tools: string[]

  /** A fake agent that, like Claude, lists the tools of the MCP server it was given. */
  const listsToolsThenAnswers = (answer: Investigation) => async (request: AgentRequest) => {
    const config = request.mcpConfig.mcpServers['ticketsmith'] as {
      url: string
      headers: Record<string, string>
    }
    const client = new Client({ name: 'fake-agent', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    })
    await client.connect(transport as Transport)
    tools = (await client.listTools()).tools.map((tool) => tool.name)
    await client.close()
    return answer
  }

  beforeEach(async () => {
    tools = []
    // No ticket source: repositories and a database that allows proposed changes.
    cli = await (await FakeCli.create()).withProject(
      withDatabases(withRepositories(testProject(null), [testRepository('api')]), [
        testDatabase('main', { allowChanges: true }),
      ]),
    )
    const located = await cli.services.projects.locate('acme')
    if (!located.ok) throw new Error('missing')
    paths = located.value
  })
  afterEach(() => cli.cleanup())

  const dirOf = (name: string) => join(paths.outDir, 'investigations', name)
  const today = () => new Date().toISOString().slice(0, 10)

  it('investigates without a ticket, read-only, and writes the analysis with real values back', async () => {
    cli.agent.reply(listsToolsThenAnswers(investigation()))

    expect(await cli.run('investigate', ...QUESTION)).toBeNull()

    const [request] = cli.agent.requests
    expect(request?.prompt).toContain('about the project "acme". There is no ticket.')
    expect(request?.prompt).toContain('This project has: databases, repos.')
    expect(request?.prompt).toContain('why does [EMAIL_1]@northwind.mx get two invoices?')
    expect(request?.playbook).toMatch(/^# Playbook: investigate a question/)
    expect(JSON.stringify(request)).not.toContain('ana@northwind.mx')

    expect(tools).toContain('db_select')
    expect(tools).toContain('repo_search')
    expect(tools).not.toContain('db_propose_change')
    expect(tools.some((tool) => tool.startsWith('code_') || tool.startsWith('jira_'))).toBe(false)

    const dir = dirOf(`${today()}-why-does-email-1-northwind-mx-get-two-invoices`)
    const analysis = await readFile(join(dir, 'analysis.md'), 'utf8')
    expect(analysis).toContain('> why does ana@northwind.mx get two invoices?')
    expect(analysis).toContain('Invoices for ana@northwind.mx are generated twice')
    expect(analysis.indexOf('The invoice job is not idempotent')).toBeLessThan(
      analysis.indexOf('Typo in a log message'),
    )
    expect(analysis).toContain('**Severity:** high · **Confidence:** medium')
    expect(analysis).toContain('**code** `api/src/jobs/invoices.js:58`')
    expect(analysis).toContain('Token [SECRET_1].')
    expect(await readFile(join(dir, 'question.md'), 'utf8')).toBe(
      'why does ana@northwind.mx get two invoices?\n',
    )

    const record = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'))
    expect(record).toMatchObject({
      investigation: `${today()}-why-does-email-1-northwind-mx-get-two-invoices`,
      playbook: { name: 'investigate', source: 'built-in' },
      findings: 2,
      attempts: 1,
    })
    expect(JSON.stringify(record)).not.toContain('ana@')

    expect(cli.audit.entries.map((entry) => entry.tool)).toEqual(['agent_run'])
    expect(JSON.stringify(cli.audit.entries)).not.toContain('ana@northwind.mx')

    expect(cli.stdout).toContain('Invoices for ana@northwind.mx are generated twice')
    expect(cli.stdout).toContain('Findings: 1 high · 1 info')
    expect(cli.stderr).toContain('Investigating with Claude (playbook investigate, read-only')
  })

  it('keeps earlier runs of the same question and prints the record as JSON', async () => {
    cli.agent.reply(investigation(), investigation({ findings: [] }))
    expect(await cli.run('investigate', 'review the invoice job')).toBeNull()
    expect(await cli.run('--json', 'investigate', 'review the invoice job')).toBeNull()

    expect(existsSync(dirOf(`${today()}-review-the-invoice-job`))).toBe(true)
    expect(JSON.parse(cli.stdout)).toMatchObject({
      investigation: `${today()}-review-the-invoice-job-2`,
      findings: 0,
    })
    const second = await readFile(
      join(dirOf(`${today()}-review-the-invoice-job-2`), 'analysis.md'),
      'utf8',
    )
    expect(second).toContain('_No findings._')
  })

  it('uses a project playbook and the model and budget overrides', async () => {
    await mkdir(join(paths.knowledgeDir, 'playbooks'), { recursive: true })
    await writeFile(join(paths.knowledgeDir, 'playbooks', 'audit.md'), '# Our audit playbook\n')
    cli.agent.reply(investigation())

    expect(
      await cli.run(
        'investigate',
        'review payments',
        '--playbook',
        'audit',
        '--model',
        'opus',
        '--budget',
        '1.5',
      ),
    ).toBeNull()
    const [request] = cli.agent.requests
    expect(request).toMatchObject({
      playbook: '# Our audit playbook\n',
      model: 'opus',
      maxBudgetUsd: 1.5,
    })
  })

  it('explains what is missing instead of running the agent', async () => {
    expect((await cli.run('investigate', '  '))?.message).toMatch(/Give a question/)
    expect((await cli.run('investigate', 'x'.repeat(2001)))?.message).toMatch(/too long/)
    expect((await cli.run('investigate', 'review', '--playbook', 'nope'))?.message).toMatch(
      /No playbook "nope"/,
    )

    const empty = await (await FakeCli.create()).withProject(testProject(null, 'bare'))
    expect((await empty.run('investigate', 'review payments'))?.message).toMatch(
      /nothing to investigate with/,
    )
    await empty.cleanup()
    expect(cli.agent.requests).toHaveLength(0)
  })

  it('reports an agent answer that never matches the schema and writes nothing', async () => {
    cli.agent.reply({ summary: 'incomplete' }, { summary: 'still incomplete' })
    expect((await cli.run('investigate', 'review payments'))?.message).toMatch(
      /did not have the expected shape/,
    )
    expect(existsSync(join(paths.outDir, 'investigations'))).toBe(false)
  })
})
