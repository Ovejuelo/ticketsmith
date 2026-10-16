import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest, FeatureDesign, FeatureImplementation } from '#src/core/agent/index.ts'
import { openProject } from '#src/core/cli/index.ts'
import type { ProjectPaths, RepositoryConfig } from '#src/core/project/index.ts'
import { newMigrations, parseAnswers } from '#src/features/code/feature-files.ts'
import { withRelated } from '#src/features/code/push.ts'
import { loadFeatureState, saveFeatureState } from '#src/features/code/run-feature.ts'
import { FakeCli, testProject, testRepository, withRepositories } from '#tests/support/fake-cli.ts'
import { runGit, TestRemote } from '#tests/support/git-repos.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

const design = (questions: FeatureDesign['questions'] = []): FeatureDesign => ({
  understanding: 'Volume discounts for wholesale customers.',
  assumptions: ['Discounts apply per order'],
  questions,
  spec: {
    summary: 'Orders of 10 or more units get a volume discount.',
    behavior: ['10+ units: 5% off'],
    acceptanceCriteria: ['10 units at $100 cost $950', 'Fewer than 10 units cost full price'],
    outOfScope: ['Coupons'],
  },
  plan: {
    repos: [{ repo: 'api', changes: ['src/pricing.js: apply the volume discount'] }],
    schemaChanges: ['migrations/002-volume-discounts.sql: discount tiers table'],
    tests: ['test/pricing.test.js: both criteria'],
    risks: ['Rounding'],
    rollout: 'Deploy the API, then announce.',
  },
})

const implementation: FeatureImplementation = {
  summary: 'Volume discounts are applied to orders of 10+ units.',
  rootCause: 'New functionality.',
  changes: [{ repo: 'api', file: 'src/pricing.js', what: 'Volume discount' }],
  testsAdded: ['test/pricing.test.js: volume discount'],
  testsPassed: true,
  risks: [],
  prTitle: 'feat(OPS-9): volume discounts',
  prDescription: 'Adds volume discounts.',
  acceptanceCriteria: [
    { criterion: '10 units at $100 cost $950', met: true, evidence: 'test/pricing.test.js' },
    { criterion: 'Fewer than 10 units cost full price', met: false, evidence: 'not covered yet' },
  ],
  migrations: ['api/migrations/002-volume-discounts.sql'],
}

describe('parsing questions.md', () => {
  const questions = [
    { id: 'Q1', question: 'Which customers?', why: 'Scope' },
    { id: 'Q2', question: 'Which tiers?', why: 'Rules' },
  ]
  it('reads multi-line answers and reports the open ones', () => {
    const text =
      '## Q1. Which customers?\n\nWhy it matters: Scope\n\nAnswer:\n\nWholesale only.\nNot retail.\n\n## Q2. Which tiers?\n\nWhy it matters: Rules\n\nAnswer:\n\n'
    expect(parseAnswers(text, questions)).toEqual({
      ok: true,
      value: { answers: { Q1: 'Wholesale only.\nNot retail.' }, open: [questions[1]] },
    })
    expect(
      parseAnswers(
        '## Q1. Which customers?\nAnswer: inline answer\n## Q2. x\nAnswer: b',
        questions,
      ),
    ).toMatchObject({
      ok: true,
      value: { answers: { Q1: 'inline answer', Q2: 'b' } },
    })
  })
  it('explains a broken file', () => {
    expect(parseAnswers('## Q1. Which customers?\nAnswer: yes', questions)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Q2'),
    })
    expect(parseAnswers('## Q1. x\nno marker\n## Q2. y\nAnswer: b', questions)).toMatchObject({
      ok: false,
      error: expect.stringContaining('"Answer:"'),
    })
  })
  it('finds new migration files in a patch', () => {
    const patch =
      'diff --git a/migrations/002-x.sql b/migrations/002-x.sql\nnew file mode 100644\n--- /dev/null\ndiff --git a/src/a.js b/src/a.js\nindex 1..2\ndiff --git a/src/db/migrate/3.rb b/src/db/migrate/3.rb\nnew file mode 100644\n'
    expect(newMigrations(patch)).toEqual(['migrations/002-x.sql', 'src/db/migrate/3.rb'])
  })
  it('links sibling pull requests and the ticket', () => {
    const repo = (name: string, pr: string | null) => ({
      repo: name,
      dir: '/x',
      branch: 'feature/OPS-9-x',
      base: 'b',
      target: 'develop',
      commit: 'c',
      tests: null,
      pushed: pr !== null,
      pullRequest: pr,
    })
    const body = withRelated('OPS-9', 'Adds it.', repo('web', null), [
      repo('api', 'https://host/pr/1'),
      repo('web', null),
    ])
    expect(body).toBe(
      'Adds it.\n\n---\nTicket: OPS-9\nRelated changes:\n- api: https://host/pr/1\n',
    )
  })
})

describe('ticketsmith feature', () => {
  let cli: FakeCli
  let remote: TestRemote
  let repo: RepositoryConfig
  let paths: ProjectPaths

  beforeEach(async () => {
    remote = new TestRemote({ fixture: 'api-express', branch: 'master' })
    remote.branch('develop')
    repo = testRepository('api', {
      url: remote.url,
      branches: { fix: 'master', feature: 'develop' },
      protectedBranches: ['master', 'develop'],
      allowCodeChanges: true,
      testCommand: 'echo ok',
    })
    cli = await (await FakeCli.create()).withProject(
      withRepositories(testProject({ projectKey: 'OPS' }), [repo]),
    )
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-9', { summary: 'Descuento por volumen' }),
    ])
    paths = (await openProject(cli.services, undefined)).paths
  })
  afterEach(async () => {
    remote[Symbol.dispose]()
    await cli.cleanup()
  })

  const file = (name: string) => readFile(join(paths.outDir, 'OPS-9', 'feature', name), 'utf8')

  it('asks first, waits for answers in questions.md, then designs with them masked', async () => {
    cli.agent.reply(
      design([{ question: 'Which customers get it?', why: 'It changes the rules' }]),
      design(),
    )

    expect(await cli.run('feature', 'ops-9')).toBeNull()
    expect(cli.stdout).toContain('The design needs 1 answer(s) first')
    expect(await file('questions.md')).toContain('## Q1. Which customers get it?')
    expect(await file('spec.md')).toMatch(/^# OPS-9: spec \(tentative/)

    expect(await cli.run('feature', 'OPS-9')).toBeNull()
    expect(cli.stdout).toContain('waiting for answers to Q1')
    expect(cli.agent.requests).toHaveLength(1) // no run without answers

    const questions = await file('questions.md')
    await writeFile(
      join(paths.outDir, 'OPS-9', 'feature', 'questions.md'),
      questions.replace('Answer:\n', 'Answer:\nWholesale, e.g. compras@northwind.mx\n'),
    )
    expect(await cli.run('feature', 'OPS-9')).toBeNull()
    const second = cli.agent.requests[1]
    expect(second?.prompt).toContain('Answers to your questions:')
    expect(second?.prompt).toContain('[EMAIL_1]@northwind.mx')
    expect(second?.prompt).not.toContain('compras@northwind.mx')
    expect(second?.prompt).toContain('Previous design (round 1)')
    expect(await file('plan.md')).toContain('## api\n\n- src/pricing.js: apply the volume discount')
    expect((await loadFeatureState(paths.outDir, 'OPS-9')).ok).toBe(true)
    const state = await loadFeatureState(paths.outDir, 'OPS-9')
    expect(state.ok && state.value?.status).toBe('plan-ready')
  })

  it('needs the plan approved before any code, and a rejection redesigns with the feedback', async () => {
    cli.agent.reply(design())
    expect(await cli.run('feature', 'OPS-9')).toBeNull()
    expect((await cli.run('feature', 'implement', 'OPS-9'))?.message).toMatch(
      /not approved \(plan-ready\)/,
    )
    expect((await cli.run('feature', 'approve', 'OPS-9'))?.message).toMatch(/interactive terminal/)

    expect(
      await cli.run('feature', 'reject', 'OPS-9', '--feedback', 'Also 20+ units: 10% off'),
    ).toBeNull()
    expect(await cli.run('feature', 'OPS-9')).toBeNull()
    expect(cli.agent.requests[1]?.prompt).toContain('- Also 20+ units: 10% off')
  })

  it('implements the approved plan from the feature branch, reports criteria and migrations, and does not push', async () => {
    cli.agent.reply(design())
    expect(await cli.run('feature', 'OPS-9')).toBeNull()
    // Approval is interactive; here the test stands in for the person.
    const state = await loadFeatureState(paths.outDir, 'OPS-9')
    if (!state.ok || state.value === null) throw new Error('no state')
    await saveFeatureState(paths.outDir, {
      ...state.value,
      status: 'approved',
      approval: { at: 'now', by: 'tester' },
    })

    cli.agent.reply(async (request: AgentRequest) => {
      const dir = request.workspace?.dirs[0] ?? ''
      await writeFile(
        join(dir, 'migrations', '002-volume-discounts.sql'),
        'CREATE TABLE discount_tiers (id INT);\n',
      )
      await writeFile(join(dir, 'src', 'pricing.js'), 'module.exports = 1\n')
      return implementation
    })
    expect(await cli.run('feature', 'implement', 'OPS-9')).toBeNull()

    const request = cli.agent.requests.at(-1)
    expect(request?.playbook).toMatch(/^# Playbook: implement approved new functionality/)
    expect(request?.prompt).toContain('Approved spec and plan (JSON):')
    expect(request?.prompt).toContain('10 units at $100 cost $950')
    const worktree = join(paths.worktreesDir, 'OPS-9-feature', 'api')
    expect(request?.workspace?.dirs).toEqual([worktree])
    expect(runGit(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'feature/OPS-9-descuento-por-volumen',
    )
    expect(runGit(worktree, 'merge-base', 'HEAD', 'refs/remotes/origin/develop').trim()).toBe(
      runGit(remote.dir, 'rev-parse', 'develop').trim(),
    )

    const summary = await readFile(
      join(paths.outDir, 'OPS-9', 'feature', 'code', 'summary.md'),
      'utf8',
    )
    expect(summary).toMatch(/^# OPS-9: new functionality/)
    expect(summary).toContain('| Fewer than 10 units cost full price | **no** | not covered yet |')
    expect(summary).toContain('- api/migrations/002-volume-discounts.sql')
    expect(cli.stdout).toContain('Acceptance criteria: 1 of 2 met')
    expect(cli.stdout).toContain('ticketsmith feature push OPS-9')
    expect(runGit(remote.dir, 'branch', '--list', 'feature/*').trim()).toBe('')

    expect(await cli.run('feature', 'status')).toBeNull()
    expect(cli.stdout).toMatch(/OPS-9 {2}implemented {2}round 1/)
  })
})
