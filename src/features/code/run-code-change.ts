import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import {
  type CodeChange,
  CodeChangeSchema,
  describeAgentError,
  loadPlaybook,
  runStructured,
} from '../../core/agent/index.ts'
import type { AgentToolServer, ConnectedTickets, OpenedProject } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import type { CodeToolContext } from '../../core/mcp/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../../core/output/index.ts'
import {
  branchDiff,
  changeBranches,
  commitAll,
  prepareWorktree,
  projectRepositories,
  type Worktree,
  type WorktreeKind,
} from '../../core/repos/index.ts'
import type { Services } from '../../core/services/index.ts'
import { describeTicketSourceError, type TicketKey } from '../../core/tickets/index.ts'
import { type CodeRun, CodeRunSchema, type RepoOutcome } from './code-run.schema.ts'
import { runTests } from './run-tests.ts'

export type CodeOptions = {
  readonly playbook: string
  readonly repos?: readonly string[] | undefined
  readonly model?: string | undefined
  readonly budgetUsd?: number | undefined
}

export type CodeOutcome<T extends CodeChange = CodeChange> = {
  readonly change: T
  readonly run: CodeRun
  readonly stats: Readonly<Record<string, string>>
  /** Patch per repository, against the base the branch started from. */
  readonly patches: Readonly<Record<string, string>>
  readonly dir: string
}

/** out/<KEY>/code (fixes) or out/<KEY>/feature/code (new functionality). */
export const codeOutputDir = (outDir: string, key: string, kind: WorktreeKind = 'fix'): string =>
  kind === 'fix'
    ? join(ticketOutputDir(outDir, key), 'code')
    : join(ticketOutputDir(outDir, key), 'feature', 'code')

export const loadCodeRun = async (dir: string, key: string): Promise<Result<CodeRun, string>> => {
  try {
    const parsed = CodeRunSchema.safeParse(
      JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')),
    )
    return parsed.success ? ok(parsed.data) : err(`${join(dir, 'run.json')} is unreadable.`)
  } catch {
    return err(`No code change for ${key} yet.`)
  }
}

export const saveCodeRun = async (dir: string, run: CodeRun): Promise<Result<void, string>> => {
  const written = await writeOutputFiles(dir, { 'run.json': `${JSON.stringify(run, null, 2)}\n` })
  return written.ok ? ok(undefined) : err(describeOutputError(written.error))
}

const renderSummary = (
  key: string,
  title: string,
  change: CodeChange,
  repos: readonly RepoOutcome[],
  stats: Readonly<Record<string, string>>,
  extra: readonly string[],
): string =>
  [
    `# ${key}: ${title}`,
    '',
    '> Written by the agent in a worktree per repository; review the diffs before pushing.',
    '',
    '## Summary',
    '',
    change.summary,
    '',
    '## Root cause',
    '',
    change.rootCause,
    '',
    '## Changes',
    '',
    ...change.changes.map((c) => `- ${c.repo} \`${c.file}\`: ${c.what}`),
    '',
    '## Tests',
    '',
    ...(change.testsAdded.length > 0
      ? change.testsAdded.map((t) => `- Added: ${t}`)
      : ['- No tests added.']),
    `- The agent reported: ${change.testsPassed ? 'passing' : 'NOT passing'}.`,
    ...repos.map((r) =>
      r.tests === null
        ? `- ${r.repo}: no test command configured.`
        : `- ${r.repo}, run again by Ticketsmith: ${r.tests.passed ? 'passed' : r.tests.timedOut ? 'timed out' : `FAILED (exit ${r.tests.exitCode})`}.`,
    ),
    '',
    '## Risks',
    '',
    ...(change.risks.length > 0 ? change.risks.map((risk) => `- ${risk}`) : ['- None noted.']),
    '',
    ...extra,
    '## Branches',
    '',
    ...repos.map(
      (r) =>
        `- ${r.repo}: \`${r.branch}\` → \`${r.target}\`${r.commit === null ? ' (no changes)' : ` at ${r.commit.slice(0, 7)}`}\n\n\`\`\`\n${(stats[r.repo] ?? '').trim()}\n\`\`\``,
    ),
    '',
  ].join('\n')

/** What differs between fixing a bug and building new functionality on the same machinery. */
export type WorktreeChangeSpec<T extends CodeChange> = {
  readonly kind: WorktreeKind
  readonly schema: z.ZodType<T>
  readonly title: string
  /** `mask` puts text through the run's vault before it reaches the agent. */
  prompt(key: string, worktrees: readonly Worktree[], mask: (text: string) => string): string
  /** Extra summary sections (e.g. acceptance criteria), from the answer and the patches. */
  summarize?(change: T, patches: Readonly<Record<string, string>>): readonly string[]
}

const FIX: WorktreeChangeSpec<CodeChange> = {
  kind: 'fix',
  schema: CodeChangeSchema,
  title: 'code change',
  prompt: (key, worktrees) =>
    [
      `Fix ticket ${key} in code.`,
      `Your worktrees: ${worktrees.map((w) => `${w.repository.config.name} (branch ${w.branch}) at ${w.dir}`).join('; ')}.`,
      'Read knowledge_read("brief.md") and the ticket (jira_get_issue) first. Follow the playbook in your instructions and finish with the required JSON answer.',
    ].join('\n'),
}

/** `ticketsmith code <KEY>`: fix a ticket from each repository's fix branch. */
export const runCodeChange = (
  services: Services,
  opened: OpenedProject,
  tickets: ConnectedTickets,
  key: TicketKey,
  options: CodeOptions,
  startToolServer: (code: CodeToolContext) => Promise<AgentToolServer>,
): Promise<Result<CodeOutcome, string>> =>
  runWorktreeChange(services, opened, tickets, key, options, FIX, startToolServer)

/**
 * The agent changes code in a worktree per repository (file tools confined to them, tests through
 * code_run_tests, no shell). Then Ticketsmith commits, runs the tests again itself, and writes the
 * summary, one diff per repository and run.json. Nothing is pushed here.
 */
export const runWorktreeChange = async <T extends CodeChange>(
  services: Services,
  opened: OpenedProject,
  tickets: ConnectedTickets,
  key: TicketKey,
  options: CodeOptions,
  spec: WorktreeChangeSpec<T>,
  startToolServer: (code: CodeToolContext) => Promise<AgentToolServer>,
): Promise<Result<CodeOutcome<T>, string>> => {
  const { project, paths } = opened
  const all = projectRepositories(project, paths)
  const unknown = (options.repos ?? []).filter((name) => !all.some((r) => r.config.name === name))
  if (unknown.length > 0) return err(`Unknown repository: ${unknown.join(', ')}.`)
  const chosen = all.filter((r) =>
    options.repos === undefined ? r.config.allowCodeChanges : options.repos.includes(r.config.name),
  )
  const blocked = chosen.filter((r) => !r.config.allowCodeChanges)
  if (blocked.length > 0) {
    return err(
      `Code changes are off for ${blocked.map((r) => r.config.name).join(', ')}: set allowCodeChanges: true in project.yaml.`,
    )
  }
  if (chosen.length === 0) {
    return err(
      'No repository allows code changes: set allowCodeChanges: true on a repository (`ticketsmith project add repos`).',
    )
  }

  const ticket = await tickets.source.getTicket(key)
  if (!ticket.ok) return err(describeTicketSourceError(ticket.error))
  const playbook = await loadPlaybook(paths.knowledgeDir, options.playbook)
  if (!playbook.ok) return playbook

  const worktrees: Worktree[] = []
  for (const repository of chosen) {
    const prepared = await prepareWorktree(
      paths,
      repository,
      ticket.value.key,
      ticket.value.summary,
      spec.kind,
    )
    if (!prepared.ok) return err(`${repository.config.name}: ${prepared.error}`)
    worktrees.push(prepared.value)
  }

  const testTimeoutMs = project.code.testTimeoutMinutes * 60_000
  const model = options.model ?? project.agent.model
  const server = await startToolServer({
    worktrees: worktrees.map((w) => ({
      repo: w.repository.config.name,
      dir: w.dir,
      testCommand: w.repository.config.testCommand,
      node: w.repository.config.runtime.node,
    })),
    testTimeoutMs,
  })
  let change: T
  let costUsd = 0
  let turns = 0
  try {
    const started = Date.now()
    const result = await runStructured(
      services.agentFor(project),
      {
        prompt: `Project "${project.name}".\n${spec.prompt(ticket.value.key, worktrees, server.mask)}`,
        playbook: playbook.value.text,
        mcpConfig: server.mcpConfig,
        model,
        maxBudgetUsd: options.budgetUsd ?? project.agent.maxBudgetUsd,
        timeoutMs: project.agent.timeoutMinutes * 60_000,
        workspace: { dirs: worktrees.map((w) => w.dir) },
      },
      spec.schema,
    )
    await server.record({
      tool: 'agent_run',
      input: {
        ticket: ticket.value.key,
        playbook: playbook.value.name,
        model: model ?? 'default',
        repos: worktrees.map((w) => w.repository.config.name),
      },
      ok: result.ok,
      ...(result.ok ? {} : { error: describeAgentError(result.error) }),
      durationMs: Date.now() - started,
    })
    if (!result.ok) return err(describeAgentError(result.error))
    change = result.value.value
    costUsd = result.value.runs.reduce((sum, run) => sum + run.costUsd, 0)
    turns = result.value.runs.reduce((sum, run) => sum + run.turns, 0)
    // Real values for the local summary only; the pull request text stays as written (masked).
    change = {
      ...change,
      summary: server.reveal(change.summary),
      rootCause: server.reveal(change.rootCause),
    }
  } finally {
    await server.close()
  }

  const outcomes: RepoOutcome[] = []
  const stats: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (const worktree of worktrees) {
    const name = worktree.repository.config.name
    const commit = await commitAll(worktree.dir, change.prTitle)
    if (!commit.ok) return err(`${name}: ${commit.error}`)
    const command = worktree.repository.config.testCommand
    const tests =
      command === undefined
        ? null
        : await runTests({
            dir: worktree.dir,
            command,
            node: worktree.repository.config.runtime.node,
            timeoutMs: testTimeoutMs,
          })
    const diff = await branchDiff(worktree.dir, worktree.base)
    if (!diff.ok) return err(`${name}: ${diff.error}`)
    stats[name] = diff.value.stat
    files[`${name}.diff`] = diff.value.patch
    outcomes.push({
      repo: name,
      dir: worktree.dir,
      branch: worktree.branch,
      base: worktree.base,
      target: changeBranches(worktree.repository.config, spec.kind).target,
      commit: commit.value,
      tests:
        tests === null
          ? null
          : {
              exitCode: tests.exitCode,
              passed: tests.exitCode === 0 && !tests.timedOut,
              timedOut: tests.timedOut,
            },
      pushed: false,
      pullRequest: null,
    })
  }

  const run: CodeRun = {
    ticket: ticket.value.key,
    kind: spec.kind,
    playbook: playbook.value.name,
    finishedAt: new Date().toISOString(),
    costUsd,
    turns,
    pullRequest: { title: change.prTitle, body: change.prDescription },
    repos: outcomes,
  }
  const dir = codeOutputDir(paths.outDir, ticket.value.key, spec.kind)
  const patches = Object.fromEntries(
    Object.entries(files).map(([file, patch]) => [file.replace(/\.diff$/, ''), patch]),
  )
  const written = await writeOutputFiles(dir, {
    ...files,
    'summary.md': renderSummary(
      ticket.value.key,
      spec.title,
      change,
      outcomes,
      stats,
      spec.summarize?.(change, patches) ?? [],
    ),
    'run.json': `${JSON.stringify(run, null, 2)}\n`,
  })
  if (!written.ok) return err(describeOutputError(written.error))
  return ok({ change, run, stats, patches, dir })
}
