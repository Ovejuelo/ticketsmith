import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditLog } from '../audit/index.ts'
import { err, ok, type Result } from '../kernel/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../output/index.ts'
import {
  describeTicketSourceError,
  type TicketKey,
  type TicketTransition,
  type TicketWriter,
} from '../tickets/index.ts'

export const WRITES_OFF =
  'Writes to the ticket source are off for this project: set allowWrites: true on it (`ticketsmith project add tickets --allow-writes`); the token needs write:jira-work.'

export type Confirm = {
  /** Shows text to the person. */
  show(text: string): void
  /** A yes/no question; false unless the person agrees. */
  ask(question: string): Promise<boolean>
}

/** The comment to post: a given file, or out/<KEY>/jira_comment.md. */
export const readComment = async (
  outDir: string,
  key: string,
  file: string | undefined,
): Promise<Result<string, string>> => {
  const path = file ?? join(ticketOutputDir(outDir, key), 'jira_comment.md')
  try {
    const text = (await readFile(path, 'utf8')).trim()
    return text === '' ? err(`${path} is empty.`) : ok(text)
  } catch {
    return err(
      `No comment to post: ${path} does not exist (run \`ticketsmith process ${key}\`, or pass --file).`,
    )
  }
}

/**
 * Posts a comment after the person read the exact text and agreed. Audited by hash and length,
 * never by content; the link is kept in out/<KEY>/jira_comment.posted.json.
 */
export const postComment = async (
  writer: TicketWriter,
  audit: AuditLog,
  outDir: string,
  key: TicketKey,
  text: string,
  confirm: Confirm,
): Promise<Result<string | null, string>> => {
  confirm.show(`Comment for ${key}, exactly as it will be posted:\n\n${text}\n`)
  if (!(await confirm.ask(`Post this comment to ${key}?`))) return ok(null)
  const started = Date.now()
  const posted = await writer.addComment(key, text)
  await audit.record({
    tool: 'ticket_comment',
    input: {
      ticket: key,
      sha256: createHash('sha256').update(text).digest('hex'),
      chars: text.length,
    },
    ok: posted.ok,
    ...(posted.ok ? {} : { error: describeTicketSourceError(posted.error) }),
    durationMs: Date.now() - started,
  })
  if (!posted.ok) return err(describeTicketSourceError(posted.error))
  const written = await writeOutputFiles(ticketOutputDir(outDir, key), {
    'jira_comment.posted.json': `${JSON.stringify({ url: posted.value.url, at: new Date().toISOString() }, null, 2)}\n`,
  })
  return written.ok ? ok(posted.value.url) : err(describeOutputError(written.error))
}

/** Finds a transition by its name or its target status (case-insensitive). */
export const findTransition = (
  transitions: readonly TicketTransition[],
  wanted: string,
): TicketTransition | undefined => {
  const target = wanted.trim().toLowerCase()
  return transitions.find((t) => t.name.toLowerCase() === target || t.to.toLowerCase() === target)
}

/** The transition the analysis suggested, from analysis.md ("**Suggested transition:** Done"). */
export const suggestedTransition = async (outDir: string, key: string): Promise<string | null> => {
  const analysis = await readFile(join(ticketOutputDir(outDir, key), 'analysis.md'), 'utf8').catch(
    () => '',
  )
  return /\*\*Suggested transition:\*\* (.+)$/m.exec(analysis)?.[1]?.trim() ?? null
}

export const applyTransition = async (
  writer: TicketWriter,
  audit: AuditLog,
  key: TicketKey,
  transition: TicketTransition,
  confirm: Confirm,
): Promise<Result<boolean, string>> => {
  if (!(await confirm.ask(`Move ${key} with "${transition.name}" (to ${transition.to})?`)))
    return ok(false)
  const started = Date.now()
  const moved = await writer.transition(key, transition.id)
  await audit.record({
    tool: 'ticket_transition',
    input: { ticket: key, transition: transition.name, to: transition.to },
    ok: moved.ok,
    ...(moved.ok ? {} : { error: describeTicketSourceError(moved.error) }),
    durationMs: Date.now() - started,
  })
  return moved.ok ? ok(true) : err(describeTicketSourceError(moved.error))
}
