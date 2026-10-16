import { Command } from 'commander'
import {
  askText,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
} from '../../core/cli/index.ts'
import { ChangeStore } from '../../core/database/index.ts'
import { approveAndExecute, rejectChange } from './approve-change.ts'
import { effectiveStatus, renderChange } from './render-change.ts'

export const changesCommand = ({ io, servicesFor }: CommandDeps): Command => {
  const opened = (command: Command) =>
    openProject(servicesFor(command), globalOptions(command).project)

  return new Command('changes')
    .description('Review, approve or reject database changes the agent proposed')
    .addCommand(
      new Command('list')
        .description('Proposed changes, newest first')
        .action(async (_, command: Command) => {
          const { paths } = await opened(command)
          const changes = await new ChangeStore(paths.changesDir).list()
          if (globalOptions(command).json) {
            io.out(`${JSON.stringify(changes, null, 2)}\n`)
            return
          }
          if (changes.length === 0) {
            io.out('No changes proposed in this project.\n')
            return
          }
          const now = new Date()
          for (const change of changes) {
            io.out(
              `${change.id}  ${effectiveStatus(change, now).padEnd(9)} ${change.database.padEnd(12)} ${(change.ticket ?? '-').padEnd(10)} ${change.kind.toUpperCase()} ${change.preflight.rows} row(s) of ${change.table}  ${change.createdAt.slice(0, 16)}\n`,
            )
          }
        }),
    )
    .addCommand(
      new Command('show')
        .description('Everything about one change, with real values')
        .argument('<id>', 'change id, e.g. cr-1a2b3c4d')
        .action(async (id: string, _, command: Command) => {
          const { paths } = await opened(command)
          const change = orFail(await new ChangeStore(paths.changesDir).load(id), String)
          io.out(
            globalOptions(command).json
              ? `${JSON.stringify(change, null, 2)}\n`
              : renderChange(change, new Date()),
          )
        }),
    )
    .addCommand(
      new Command('approve')
        .description('Review and run one change (interactive: you type the database name)')
        .argument('<id>', 'change id, e.g. cr-1a2b3c4d')
        .action(async (id: string, _, command: Command) => {
          // Approval is a person at a terminal: never a flag, a pipe, a script or an agent.
          if (!io.interactive)
            fail('Approving a change needs an interactive terminal: run it yourself.')
          const services = servicesFor(command)
          const project = await opened(command)
          const outcome = orFail(
            await approveAndExecute(services, project, id, {
              show: (text) => io.out(text),
              confirm: (message) => askText({ message }),
            }),
            String,
          )
          io.out(
            [
              `Change ${id} ran: ${outcome.change.result?.affectedRows ?? 0} row(s) affected and committed.`,
              ...outcome.files.map((file) => `  ${file}`),
              '',
            ].join('\n'),
          )
        }),
    )
    .addCommand(
      new Command('reject')
        .description('Reject one change; nothing runs')
        .argument('<id>', 'change id, e.g. cr-1a2b3c4d')
        .option('--reason <text>', 'why, for the record')
        .action(async (id: string, options: { reason?: string }, command: Command) => {
          const change = orFail(
            await rejectChange(await opened(command), id, options.reason),
            String,
          )
          io.out(`Change ${change.id} rejected.\n`)
        }),
    )
}
