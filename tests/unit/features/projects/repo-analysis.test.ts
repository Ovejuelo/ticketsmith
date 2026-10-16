import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest, RepoAnalysis } from '#src/core/agent/index.ts'
import type { ProjectPaths } from '#src/core/project/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'
import { TestRemote } from '#tests/support/git-repos.ts'

const analysis: RepoAnalysis = {
  overview: 'An Express API for accounts, maintained by luis@northwind.mx.',
  modules: [{ path: 'src/routes', purpose: 'HTTP routes' }],
  flows: [
    { name: 'Deactivate an account', steps: ['api/src/routes/accounts.js:12 updates the status'] },
  ],
  businessRules: ['Accounts are deactivated, never deleted (api/src/routes/accounts.js:13)'],
  dataModel: 'Account (src/models/account.js) with email and status.',
  risks: ['No tests for deactivation'],
  glossary: [{ term: 'inactive', meaning: 'A deactivated account' }],
}

describe('ticketsmith project refresh repos --deep', () => {
  let cli: FakeCli
  let remote: TestRemote
  let paths: ProjectPaths
  let offered: string[] = []

  /** Like Claude: lists the tools it got, then answers. */
  const listsToolsThenAnswers = async (request: AgentRequest) => {
    const config = request.mcpConfig.mcpServers['ticketsmith'] as {
      url: string
      headers: Record<string, string>
    }
    const client = new Client({ name: 'fake-agent', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      }) as Transport,
    )
    offered = (await client.listTools()).tools.map((tool) => tool.name)
    await client.close()
    return analysis
  }

  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject())
    remote = new TestRemote({ fixture: 'api-express' })
    const located = await cli.services.projects.locate('acme')
    if (!located.ok) throw new Error('missing')
    paths = located.value
    expect(
      await cli.run('project', 'add', 'repos', '--url', remote.url, '--name', 'api'),
    ).toBeNull()
    cli.agent.reply(listsToolsThenAnswers)
  })
  afterEach(async () => {
    remote[Symbol.dispose]()
    await cli.cleanup()
  })

  const analysisFile = () => readFile(join(paths.knowledgeDir, 'repos', 'api.analysis.md'), 'utf8')

  it('writes a masked analysis with only the code and knowledge tools', async () => {
    expect(await cli.run('project', 'refresh', 'repos', '--deep')).toBeNull()

    expect(offered.sort()).toEqual([
      'knowledge_read',
      'knowledge_search',
      'repo_files',
      'repo_list',
      'repo_read',
      'repo_search',
    ])
    const [request] = cli.agent.requests
    expect(request?.prompt).toContain('Analyze the repository "api"')
    expect(request?.playbook).toMatch(/^# Playbook: analyze a repository/)

    const text = await analysisFile()
    expect(text).toMatch(/^# Repository analysis: api\n/)
    expect(text).toContain(
      '### Deactivate an account\n\n1. api/src/routes/accounts.js:12 updates the status',
    )
    expect(text).toContain('[EMAIL_1]@northwind.mx')
    expect(text).not.toContain('luis@northwind.mx')
    expect(cli.stderr).toMatch(/✔ api analysis: analyzed \(\$0\.25 at [0-9a-f]{7}\)/)
  })

  it('skips commits already analyzed unless forced, and keeps the analysis across refreshes', async () => {
    expect(await cli.run('project', 'refresh', 'repos', '--deep')).toBeNull()
    expect(await cli.run('project', 'refresh', 'repos', '--deep')).toBeNull()
    expect(cli.agent.requests).toHaveLength(1)
    expect(cli.stderr).toMatch(/api analysis: unchanged/)

    expect(await cli.run('project', 'refresh', 'repos')).toBeNull()
    expect(existsSync(join(paths.knowledgeDir, 'repos', 'api.analysis.md'))).toBe(true)

    expect(await cli.run('project', 'refresh', 'repos', '--deep', '--force')).toBeNull()
    expect(cli.agent.requests).toHaveLength(2)

    remote.commit({ 'src/new.js': 'module.exports = 1\n' })
    expect(await cli.run('project', 'refresh', 'repos', '--deep')).toBeNull()
    expect(cli.agent.requests).toHaveLength(3)
  })

  it('reports agent failures and refuses --deep without repositories', async () => {
    cli.agent.reply({ kind: 'not-logged-in' })
    expect((await cli.run('project', 'refresh', 'repos', '--deep'))?.message).toBe(
      'Some analyses failed.',
    )
    expect(cli.stderr).toMatch(/! api analysis: failed \(Claude Code is not signed in/)

    expect((await cli.run('project', 'refresh', 'tickets', '--deep'))?.message).toMatch(
      /only applies to repos/,
    )
    await cli.run('project', 'remove', 'repos', '--yes')
    expect((await cli.run('project', 'refresh', '--deep'))?.message).toMatch(
      /this project has none/,
    )
  })
})
