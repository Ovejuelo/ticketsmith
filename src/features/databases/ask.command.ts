import { Command } from 'commander'
import {
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  parsePositiveInt,
  requireDatabases,
} from '../../core/cli/index.ts'
import { maskSensitiveData } from '../../core/security/index.ts'
import {
  DEFAULT_ROWS,
  MAX_ROWS,
  readGroup,
  readOne,
  renderFooter,
  renderMarkdownTable,
} from './read-query.ts'

type AskOptions = {
  readonly db?: string
  readonly group?: string
  readonly limit: number
  readonly mask: boolean
}

export const dbCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('db').description('Read-only queries on the project databases').addCommand(
    new Command('ask')
      .description('Run one guarded read-only SELECT on a database or on every database of a group')
      .argument('<sql>', 'the SELECT to run (quote it)')
      .option('--db <name>', 'database to query (optional when the project has only one)')
      .option('--group <name>', 'run on every database of this group')
      .option(
        '-n, --limit <rows>',
        `maximum rows per database (max ${MAX_ROWS})`,
        parsePositiveInt,
        DEFAULT_ROWS,
      )
      .option('--mask', 'mask sensitive data in the output', false)
      .action(async (sql: string, options: AskOptions, command: Command) => {
        if (options.limit > MAX_ROWS) fail(`--limit must be at most ${MAX_ROWS}.`)
        const global = globalOptions(command)
        const services = servicesFor(command)
        const opened = await openProject(services, global.project)
        const connections = requireDatabases(services, opened)
        const show = (text: string) =>
          io.out(`${options.mask ? maskSensitiveData(text, opened.project.masking).text : text}\n`)

        try {
          if (options.group !== undefined) {
            const answers = orFail(
              await readGroup(connections, options.group, sql, options.limit),
              String,
            )
            if (global.json) return show(JSON.stringify(answers, null, 2))
            for (const answer of answers) {
              show(
                answer.result.ok
                  ? `## ${answer.database}\n${renderMarkdownTable(answer.result.value)}\n${renderFooter(answer.database, answer.result.value)}\n`
                  : `## ${answer.database}\n! ${answer.result.error}\n`,
              )
            }
            return
          }

          const database = options.db ?? onlyDatabase(connections.configs.map((c) => c.name))
          const result = orFail(await readOne(connections, database, sql, options.limit), String)
          if (global.json) return show(JSON.stringify(result, null, 2))
          show(`${renderMarkdownTable(result)}\n\n${renderFooter(database, result)}`)
        } finally {
          await connections[Symbol.asyncDispose]()
        }
      }),
  )

const onlyDatabase = (names: readonly string[]): string =>
  names.length === 1 && names[0] !== undefined
    ? names[0]
    : fail(`Pass --db <name> or --group <name>. Databases: ${names.join(', ')}.`)
