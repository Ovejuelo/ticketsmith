import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { err, ok, type Result } from '../kernel/index.ts'
import { type TicketTypes, TicketTypesSchema } from './ticket-types.schema.ts'

export const TICKET_TYPES_FILE = 'ticket-types.md'

/** The YAML front matter of ticket-types.md, validated. */
export const parseTicketTypes = (text: string): Result<TicketTypes, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match?.[1] === undefined) {
    return err(`${TICKET_TYPES_FILE} needs a YAML front matter between "---" lines.`)
  }
  let data: unknown
  try {
    data = parse(match[1])
  } catch (error) {
    return err(
      `${TICKET_TYPES_FILE} has invalid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }
  const parsed = TicketTypesSchema.safeParse(data)
  return parsed.success
    ? ok(parsed.data)
    : err(`${TICKET_TYPES_FILE} is invalid:\n${z.prettifyError(parsed.error)}`)
}

/** The project's ticket types, or null when the project has none yet. */
export const loadTicketTypes = async (
  knowledgeDir: string,
): Promise<Result<TicketTypes | null, string>> => {
  let text: string
  try {
    text = await readFile(join(knowledgeDir, TICKET_TYPES_FILE), 'utf8')
  } catch {
    return ok(null)
  }
  return parseTicketTypes(text)
}
