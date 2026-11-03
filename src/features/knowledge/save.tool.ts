import { z } from 'zod'
import { err, ok } from '../../core/kernel/index.ts'
import { CASES_DIR, writeKnowledge } from '../../core/knowledge/index.ts'
import { defineTool } from '../../core/mcp/index.ts'
import { slugify } from '../../core/repos/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'
import { resolveWritableKnowledgeFile } from './knowledge-files.ts'

export const NOTES_DIR = 'notes'
export const MAX_CONTENT_CHARS = 20_000

const frontMatter = (fields: Readonly<Record<string, string>>): string =>
  ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---'].join('\n')

const today = (): string => new Date().toISOString().slice(0, 10)

/** One line, so a value cannot break out of the front matter. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const saveTool = defineTool({
  name: 'knowledge_save',
  title: 'Save project knowledge',
  description: `Save what you learned so the next investigation finds it with knowledge_search. Only when the user agrees. kind "case" saves a resolved ticket as knowledge/${CASES_DIR}/<ticket>.md; kind "note" saves a finding without a ticket as knowledge/${NOTES_DIR}/<topic>.md. Write the content in Markdown with these sections when they apply: "## Summary", "## Probable cause" (or "## What was asked"), "## Evidence" (queries and what they returned, repo/file:line), "## How it was resolved" (the SQL or code change a person applied), "## Open questions". The content is masked before it is written; keep placeholders such as [EMAIL_1] as they are. An existing file is never overwritten: the content is appended as a dated update. Other knowledge files (brief, playbooks, maps, schemas) cannot be written. At most ${MAX_CONTENT_CHARS} characters.`,
  inputSchema: {
    kind: z.enum(['case', 'note']).describe('"case" for a resolved ticket, "note" for a finding'),
    ticket: z.string().optional().describe('Ticket key, e.g. OPS-123 (required for a case)'),
    topic: z.string().max(120).optional().describe('Short title of the note (required for a note)'),
    type: z
      .string()
      .max(60)
      .optional()
      .describe('Ticket type of a case, e.g. bug or service-request'),
    content: z.string().min(1).max(MAX_CONTENT_CHARS).describe('Markdown body'),
  },
  requires: [],
  readOnly: false,
  availableWhen: (context) => context.knowledge.writable !== undefined,
  auditInput: ({ content, ...rest }) => ({
    ...rest,
    content: { chars: typeof content === 'string' ? content.length : 0 },
  }),
  run: async ({ kind, ticket, topic, type, content }, context) => {
    const writable = context.knowledge.writable
    if (writable === undefined) return err('Saving knowledge is not available in this session.')

    let folder: string
    let name: string
    let header: string
    if (kind === 'case') {
      const key = TicketKeySchema.safeParse(ticket?.trim().toUpperCase())
      if (!key.success) return err('A case needs the ticket key, e.g. ticket: "OPS-123".')
      folder = CASES_DIR
      name = `${key.data}.md`
      header = `${frontMatter({
        ticket: key.data,
        type: oneLine(type ?? '') || 'unclassified',
        savedBy: 'claude-code',
        savedAt: today(),
      })}\n\n# ${key.data}: resolved case`
    } else {
      const title = oneLine(topic ?? '')
      const slug = slugify(title)
      if (slug === '')
        return err('A note needs a topic with letters or digits, e.g. topic: "Fees".')
      folder = NOTES_DIR
      name = `${slug}.md`
      header = `${frontMatter({ topic: title, savedBy: 'claude-code', savedAt: today() })}\n\n# ${title}`
    }

    const target = await resolveWritableKnowledgeFile(context.knowledge.dir, folder, name)
    if (!target.ok) return target
    const body = content.trim()
    const markdown =
      target.value.existing === null
        ? `${header}\n\n${body}\n`
        : `${target.value.existing.replace(/\n*$/, '')}\n\n## Update ${today()} (Claude Code)\n\n${body}\n`

    const written = await writeKnowledge(
      target.value.root,
      `${folder}/${name}`,
      markdown,
      writable.masking,
    )
    if (!written.ok) return err(written.error.message)
    const masked = Object.entries(written.value.masked)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ${count}`)
    return ok(
      [
        `Saved knowledge/${folder}/${name}${target.value.existing === null ? '' : ' (appended an update)'}${masked.length === 0 ? '' : ` (masked: ${masked.join(', ')})`}.`,
        'It reaches the team when the user commits the project folder.',
      ].join(' '),
    )
  },
})
