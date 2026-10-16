import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest, CodeChange } from '#src/core/agent/index.ts'
import { openProject } from '#src/core/cli/index.ts'
import type { ProjectPaths, RepositoryConfig } from '#src/core/project/index.ts'
import { pushAndOpen } from '#src/features/code/push.ts'
import { describeTestRun, runTests } from '#src/features/code/run-tests.ts'
import { FakeCli, testProject, testRepository, withRepositories } from '#tests/support/fake-cli.ts'
import { runGit, TestRemote } from '#tests/support/git-repos.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

type TextContent = { type: 'text'; text: string }

const change: CodeChange = {
  summary: 'Expired cards of [EMAIL_1]@northwind.mx were accepted; now they are rejected.',
  rootCause: 'api/src/routes/accounts.js:6 never checked the card expiry.',
  changes: [{ repo: 'api', file: 'src/routes/accounts.js', what: 'Reject expired cards' }],
  testsAdded: ['test/accounts.test.js: rejects expired cards'],
  testsPassed: true,
  risks: ['Cards expiring today'],
  prTitle: 'fix(OPS-7): reject expired cards',
  prDescription: 'Rejects expired cards before charging. Reported by [EMAIL_1]@northwind.mx.',
}

/** Like Claude in a code session: edits the worktree, runs the tests through MCP, answers. */
const editsThenAnswers = (calls: string[]) => async (request: AgentRequest) => {
  const dir = request.workspace?.dirs[0]
  if (dir === undefined) throw new Error('no workspace')
  await writeFile(join(dir, 'src', 'routes', 'accounts.js'), "module.exports = 'fixed'\n")
  await writeFile(join(dir, 'FIXED'), 'yes\n')
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
  const tools = (await client.listTools()).tools.map((tool) => tool.name)
  const tests = await client.callTool({ name: 'code_run_tests', arguments: { repo: 'api' } })
  const diff = await client.callTool({ name: 'code_diff', arguments: { repo: 'api' } })
  calls.push(
    tools.join(','),
    (tests.content as TextContent[])[0]?.text ?? '',
    (diff.content as TextContent[])[0]?.text ?? '',
  )
  await client.close()
  return change
}

describe('ticketsmith code', () => {
  let cli: FakeCli
  let remote: TestRemote
  let paths: ProjectPaths
  let repo: RepositoryConfig
  let calls: string[]

  beforeEach(async () => {
    remote = new TestRemote({ fixture: 'api-express', branch: 'master' })
    repo = testRepository('api', {
      url: remote.url,
      branches: { fix: 'master', feature: 'master' },
      protectedBranches: ['master'],
      allowCodeChanges: true,
      branchPattern: 'hotfix/{key}-{slug}',
      testCommand: 'test -f FIXED && echo "1 passing" || { echo "1 failing"; exit 1; }',
    })
    cli = await (await FakeCli.create()).withProject(
      withRepositories(testProject({ projectKey: 'OPS' }), [repo]),
    )
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-7', { summary: 'Pago con tarjeta vencida' }),
    ])
    const opened = await openProject(cli.services, undefined)
    paths = opened.paths
    calls = []
  })
  afterEach(async () => {
    remote[Symbol.dispose]()
    await cli.cleanup()
  })

  it('fixes the ticket in a worktree, verifies the tests itself, commits and does not push', async () => {
    cli.agent.reply(editsThenAnswers(calls))

    expect(await cli.run('code', 'ops-7')).toBeNull()

    const worktree = join(paths.worktreesDir, 'OPS-7', 'api')
    const [request] = cli.agent.requests
    expect(request?.workspace?.dirs).toEqual([worktree])
    expect(request?.playbook).toMatch(/^# Playbook: fix a ticket in code/)
    expect(calls[0]?.split(',')).toEqual(
      expect.arrayContaining(['code_run_tests', 'code_diff', 'repo_read', 'knowledge_read']),
    )
    expect(calls[1]).toMatch(/^Tests of api passed in \d+s\. Last lines:\n\n1 passing/)
    expect(calls[2]).toContain("+module.exports = 'fixed'")

    expect(runGit(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'hotfix/OPS-7-pago-con-tarjeta-vencida',
    )
    expect(runGit(worktree, 'log', '-1', '--format=%s').trim()).toBe(
      'fix(OPS-7): reject expired cards',
    )
    expect(runGit(remote.dir, 'branch', '--list', 'hotfix/*').trim()).toBe('') // nothing pushed

    const out = join(paths.outDir, 'OPS-7', 'code')
    expect(await readFile(join(out, 'api.diff'), 'utf8')).toContain("+module.exports = 'fixed'")
    const summary = await readFile(join(out, 'summary.md'), 'utf8')
    expect(summary).toContain('- api, run again by Ticketsmith: passed.')
    const run = JSON.parse(await readFile(join(out, 'run.json'), 'utf8'))
    expect(run).toMatchObject({
      ticket: 'OPS-7',
      pullRequest: { title: 'fix(OPS-7): reject expired cards', body: change.prDescription },
      repos: [
        {
          repo: 'api',
          branch: 'hotfix/OPS-7-pago-con-tarjeta-vencida',
          target: 'master',
          pushed: false,
          pullRequest: null,
          tests: { passed: true },
        },
      ],
    })
    expect(cli.stdout).toContain('ticketsmith code push OPS-7')
    expect(cli.audit.entries.map((entry) => entry.tool)).toEqual([
      'code_run_tests',
      'code_diff',
      'agent_run',
    ])
  })

  it('pushes only after a yes, never forced, and opens the PR through the provider or gives the link', async () => {
    cli.agent.reply(editsThenAnswers(calls))
    expect(await cli.run('code', 'OPS-7')).toBeNull()
    const opened = await openProject(cli.services, undefined)
    const shown: string[] = []
    const io = (answer: boolean, token: string | null = null) => ({
      show: (text: string) => shown.push(text),
      confirm: async () => answer,
      askToken: async () => token,
    })

    expect(await pushAndOpen(cli.services, opened, 'OPS-7', undefined, io(false))).toMatchObject({
      ok: true,
    })
    expect(runGit(remote.dir, 'branch', '--list', 'hotfix/*').trim()).toBe('')

    // A file:// remote has no provider: push, then the text to paste.
    expect((await pushAndOpen(cli.services, opened, 'OPS-7', undefined, io(true))).ok).toBe(true)
    expect(runGit(remote.dir, 'branch', '--list', 'hotfix/*').trim()).toBe(
      'hotfix/OPS-7-pago-con-tarjeta-vencida',
    )
    expect(shown.at(-1)).toContain('Title: fix(OPS-7): reject expired cards')
    expect(shown.at(-1)).toContain('[EMAIL_1]@northwind.mx') // the PR text stays masked
    expect(cli.pullRequests.created).toEqual([])

    // With a provider and a token the PR is created through the API (token stored once).
    await cli.withProject(
      withRepositories(testProject({ projectKey: 'OPS' }), [{ ...repo, host: { type: 'github' } }]),
    )
    const reopened = await openProject(cli.services, undefined)
    expect(
      (await pushAndOpen(cli.services, reopened, 'OPS-7', undefined, io(true, 'ghp_test'))).ok,
    ).toBe(true)
    expect(cli.pullRequests.created[0]).toMatchObject({
      type: 'github',
      token: 'ghp_test',
      input: {
        head: 'hotfix/OPS-7-pago-con-tarjeta-vencida',
        base: 'master',
        title: 'fix(OPS-7): reject expired cards',
      },
    })
    const run = JSON.parse(await readFile(join(paths.outDir, 'OPS-7', 'code', 'run.json'), 'utf8'))
    expect(run.repos[0]).toMatchObject({
      pushed: true,
      pullRequest: expect.stringMatching(/^https:\/\/github\.example\//),
    })
  })

  it('explains what is missing and never pushes without a terminal', async () => {
    expect((await cli.run('code', 'push', 'OPS-7'))?.message).toMatch(/interactive terminal/)
    expect((await cli.run('code', 'OPS-7', '--repo', 'web'))?.message).toMatch(
      /Unknown repository: web/,
    )
    await cli.withProject(
      withRepositories(testProject({ projectKey: 'OPS' }), [{ ...repo, allowCodeChanges: false }]),
    )
    expect((await cli.run('code', 'OPS-7'))?.message).toMatch(/No repository allows code changes/)

    cli.agent.reply({ kind: 'budget-exceeded', costUsd: 3.4 })
    await cli.withProject(withRepositories(testProject({ projectKey: 'OPS' }), [repo]))
    expect((await cli.run('code', 'OPS-7'))?.message).toMatch(/\$3\.40 spent/)
  })

  it('discards the worktrees and local branches', async () => {
    cli.agent.reply(editsThenAnswers(calls))
    expect(await cli.run('code', 'OPS-7')).toBeNull()
    expect(await cli.run('code', 'status')).toBeNull()
    expect(cli.stdout).toMatch(
      /OPS-7 {2}api +hotfix\/OPS-7-pago-con-tarjeta-vencida → master {2}tests pass {2}not pushed/,
    )

    expect(await cli.run('code', 'discard', 'OPS-7', '--yes')).toBeNull()
    expect(existsSync(join(paths.worktreesDir, 'OPS-7', 'api'))).toBe(false)
  })
})

describe('runTests', () => {
  it("runs the configured command without Ticketsmith's secrets and stops it on timeout", async () => {
    process.env['TICKETSMITH_DB_SHARD1'] = 'secret'
    try {
      const env = await runTests({
        dir: process.cwd(),
        command: 'env',
        node: undefined,
        timeoutMs: 10_000,
      })
      expect(env.exitCode).toBe(0)
      expect(env.output).not.toContain('TICKETSMITH_DB_SHARD1')
      expect(env.output).toContain('CI=1')
    } finally {
      delete process.env['TICKETSMITH_DB_SHARD1']
    }
    const slow = await runTests({
      dir: process.cwd(),
      command: 'sleep 30',
      node: undefined,
      timeoutMs: 300,
    })
    expect(slow.timedOut).toBe(true)
    expect(describeTestRun('api', slow)).toMatch(/^Tests of api timed out/)
  })
})
