import { Command } from 'commander'
import {
  askConfirm,
  type CommandDeps,
  fail,
  globalOptions,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { postComment, readComment, WRITES_OFF } from '../../core/publishing/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'

export const commentCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('comment')
    .description(
      'Post a comment to a ticket (default: out/<KEY>/jira_comment.md) after you read it and agree',
    )
    .argument('<key>', 'ticket key, e.g. OPS-123')
    .option('--file <path>', 'post this Markdown file instead')
    .action(async (raw: string, options: { file?: string }, command: Command) => {
      const parsed = TicketKeySchema.safeParse(raw.trim().toUpperCase())
      if (!parsed.success) fail(`Invalid ticket key "${raw}". Expected PROJECT-123.`)
      if (!io.interactive)
        fail('Posting needs an interactive terminal: you read the comment and confirm it.')
      const services = servicesFor(command)
      const opened = await openProject(services, globalOptions(command).project)
      const tickets = await requireTickets(services, opened)
      if (tickets.writer === null) fail(WRITES_OFF)
      const text = orFail(await readComment(opened.paths.outDir, parsed.data, options.file), String)
      const url = orFail(
        await postComment(
          tickets.writer,
          services.openAuditLog(opened.project.name, opened.paths, 'tickets'),
          opened.paths.outDir,
          parsed.data,
          text,
          { show: (t) => io.out(t), ask: (q) => askConfirm(q, false) },
        ),
        String,
      )
      io.out(url === null ? 'Nothing posted.\n' : `Posted: ${url}\n`)
    })
