import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command } from 'commander'
import { loadTicketTypes, TICKET_TYPES_FILE } from '../../core/classification/index.ts'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { CASES_DIR, sectionOf } from '../../core/knowledge/index.ts'
import { describeTicketSourceError, TicketKeySchema } from '../../core/tickets/index.ts'
import {
  buildEvalCase,
  findRegressions,
  latestRun,
  loadEvalCases,
  renderReport,
  runEvals,
  saveEvalCase,
  saveRun,
} from './run-evals.ts'

const parseBudget = (value: string): number => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 500) fail(`Invalid --budget "${value}".`)
  return amount
}

const readOptional = (path: string) => readFile(path, 'utf8').catch(() => null)

const addCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('add')
    .description('Add a resolved ticket to the evals (a masked snapshot, shareable)')
    .argument('<key>', 'ticket key, e.g. OPS-123')
    .option('--expected-type <type>', 'the right type (default: the saved classification)')
    .option(
      '--solution <text>',
      'how it was really solved (default: the case note); needed by eval --full',
    )
    .action(
      async (
        raw: string,
        options: { expectedType?: string; solution?: string },
        command: Command,
      ) => {
        const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
        if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
        const services = servicesFor(command)
        const opened = await openProject(services, globalOptions(command).project)
        const { paths, project } = opened
        const types = orFail(await loadTicketTypes(paths.knowledgeDir), String)
        if (types === null)
          fail(
            `Evals need knowledge/${TICKET_TYPES_FILE}: run \`ticketsmith project refresh tickets\` to draft it.`,
          )
        const saved = await readOptional(join(paths.outDir, parsed.data, 'classification.json'))
        const expectedType =
          options.expectedType ??
          (saved === null ? undefined : (JSON.parse(saved) as { type?: string }).type)
        if (expectedType === undefined)
          fail(`Pass --expected-type: ${parsed.data} has no saved classification.`)
        if (expectedType !== 'other' && !types.types.some((type) => type.name === expectedType)) {
          fail(
            `Unknown type "${expectedType}": ${types.types.map((type) => type.name).join(', ')}, other.`,
          )
        }
        const caseFile = await readOptional(
          join(paths.knowledgeDir, CASES_DIR, `${parsed.data}.md`),
        )
        const solution =
          options.solution ??
          (caseFile === null
            ? undefined
            : (sectionOf(caseFile, 'How it was resolved') ?? undefined))
        const tickets = await requireTickets(services, opened)
        const ticket = orFail(
          await tickets.source.getTicket(parsed.data),
          describeTicketSourceError,
        )
        const file = orFail(
          await saveEvalCase(
            paths.evalsDir,
            buildEvalCase(ticket, expectedType, solution, project.masking),
          ),
          String,
        )
        io.out(
          `Added ${file} (masked, ${expectedType}${solution === undefined ? ', no solution: skipped by --full' : ''}).\n`,
        )
      },
    )

export const evalCommand = (deps: CommandDeps): Command => {
  const { io, servicesFor, startAgentToolServer } = deps
  return new Command('eval')
    .description('Measure classification (and, with --full, playbook answers) on the project evals')
    .option('--type <type>', 'only cases of this expected type')
    .option(
      '--full',
      'also run each playbook and have an LLM judge it against the real solution (costly)',
      false,
    )
    .option('--no-llm', 'classification by rules only (free)')
    .option('--budget <usd>', 'maximum total spend of a --full run', parseBudget, 10)
    .action(
      async (
        flags: { type?: string; full: boolean; llm: boolean; budget: number },
        command: Command,
      ) => {
        const global = globalOptions(command)
        const services = servicesFor(command)
        const opened = await openProject(services, global.project)
        const { paths, project } = opened
        const types = orFail(await loadTicketTypes(paths.knowledgeDir), String)
        if (types === null) fail(`Evals need knowledge/${TICKET_TYPES_FILE}.`)
        const cases = orFail(await loadEvalCases(paths.evalsDir), String).filter(
          (evalCase) => flags.type === undefined || evalCase.expectedType === flags.type,
        )
        if (cases.length === 0)
          fail('No evals yet: add resolved tickets with `ticketsmith eval add <KEY>`.')
        io.err(
          `Evaluating ${cases.length} case(s)${flags.full ? ` with --full (budget $${flags.budget.toFixed(2)})` : ''}…\n`,
        )
        const previous = await latestRun(paths.evalRunsDir)
        const run = await runEvals(
          cases,
          types,
          {
            agent: services.agentFor(project),
            knowledgeDir: paths.knowledgeDir,
            model: project.agent.model,
            classificationBudgetUsd: project.classification.maxBudgetUsd,
            runBudgetUsd: project.agent.maxBudgetUsd,
            timeoutMs: project.agent.timeoutMinutes * 60_000,
            startToolServer: ({ only, tickets }) =>
              startAgentToolServer(command, { auditCommand: 'eval', only, tickets }),
          },
          { full: flags.full, llm: flags.llm, budgetUsd: flags.budget },
        )
        orFail(await saveRun(paths.evalRunsDir, run), String)
        const regressions = findRegressions(previous, run)
        io.out(
          global.json
            ? `${JSON.stringify({ ...run, regressions }, null, 2)}\n`
            : renderReport(run, regressions),
        )
        if (regressions.length > 0)
          fail(`${regressions.length} regression(s) against the previous run.`)
      },
    )
    .addCommand(addCommand(deps))
}
