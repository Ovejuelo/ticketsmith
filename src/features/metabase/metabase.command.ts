import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command } from 'commander'
import {
  askConfirm,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireMetabase,
} from '../../core/cli/index.ts'
import { ticketOutputDir } from '../../core/output/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'
import { pickDatabase, publishReport, readReport } from './publish-report.ts'

/** The ticket summary from out/<KEY>/ticket.json, for the default question name. */
const ticketSummary = async (outDir: string, key: string): Promise<string | null> => {
  try {
    const ticket = JSON.parse(
      await readFile(join(ticketOutputDir(outDir, key), 'ticket.json'), 'utf8'),
    ) as { summary?: unknown }
    return typeof ticket.summary === 'string' ? ticket.summary : null
  } catch {
    return null
  }
}

export const metabaseCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('metabase').description('Metabase: saved questions from report queries').addCommand(
    new Command('publish')
      .description(
        'Create a Metabase question from a report query (default: out/<KEY>/report.sql) after you read it and agree',
      )
      .argument('<key>', 'ticket key, e.g. OPS-123')
      .option('--db <name>', 'project database the question runs on (default: the only mapped one)')
      .option('--name <name>', 'question name (default: "<KEY>: <ticket summary>")')
      .option('--file <path>', 'publish this SQL file instead')
      .action(
        async (
          raw: string,
          options: { db?: string; name?: string; file?: string },
          command: Command,
        ) => {
          const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
          if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
          if (!io.interactive) {
            fail('Publishing needs an interactive terminal: you read the question and confirm it.')
          }
          const services = servicesFor(command)
          const opened = await openProject(services, globalOptions(command).project)
          const { client, config } = await requireMetabase(services, opened)
          const sql = orFail(
            await readReport(opened.paths.outDir, parsed.data, options.file),
            String,
          )
          const database = orFail(pickDatabase(config, options.db), String)
          const summary = await ticketSummary(opened.paths.outDir, parsed.data)
          const url = orFail(
            await publishReport(
              client,
              config,
              services.openAuditLog(opened.project.name, opened.paths, 'metabase'),
              opened.paths.outDir,
              {
                key: parsed.data,
                sql,
                database,
                name: options.name ?? `${parsed.data}: ${summary ?? 'report'}`,
              },
              { show: (text) => io.out(text), ask: (question) => askConfirm(question, false) },
            ),
            String,
          )
          io.out(url === null ? 'Nothing created.\n' : `Created: ${url}\n`)
        },
      ),
  )
