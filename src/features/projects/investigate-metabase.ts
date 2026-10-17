import { type OpenedProject, requireMetabase } from '../../core/cli/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { writeKnowledge } from '../../core/knowledge/index.ts'
import { describeMetabaseError } from '../../core/metabase/index.ts'
import type { Services } from '../../core/services/index.ts'
import type { InvestigationOutcome } from './investigate-tickets.ts'

export const METABASE_KNOWLEDGE_FILE = 'metabase/metabase.md'

/**
 * Checks the Metabase connection and the database mapping, and writes a short knowledge file so
 * the report playbook knows which databases can become saved questions.
 */
export const investigateMetabase = async (
  services: Services,
  opened: OpenedProject,
): Promise<Result<InvestigationOutcome, string>> => {
  const { client, config } = await requireMetabase(services, opened)
  const databases = await client.databases()
  if (!databases.ok) return err(describeMetabaseError(databases.error))
  const byId = new Map(databases.value.map((database) => [database.id, database]))
  const mapped = Object.entries(config.databaseIds)
  const broken = mapped.filter(([, id]) => !byId.has(id))
  if (broken.length > 0) {
    return err(
      `Metabase has no database with id ${broken.map(([, id]) => id).join(', ')}: run \`ticketsmith project add metabase\` again.`,
    )
  }
  const lines = [
    '# Metabase',
    '',
    `Reports become saved questions in ${config.url}${config.collectionId === undefined ? '' : ` (collection ${config.collectionId})`} with \`ticketsmith metabase publish <KEY>\`, after a person agrees.`,
    '',
    '| Project database | Metabase database | Engine |',
    '| --- | --- | --- |',
    ...mapped.map(
      ([name, id]) => `| ${name} | ${byId.get(id)?.name ?? id} | ${byId.get(id)?.engine ?? ''} |`,
    ),
    '',
    'Write report queries with Metabase variables in double braces, e.g. {{start_date}}; optional filters go inside [[ … ]].',
    '',
  ]
  const written = await writeKnowledge(
    opened.paths.knowledgeDir,
    METABASE_KNOWLEDGE_FILE,
    lines.join('\n'),
    opened.project.masking,
  )
  if (!written.ok) return err(written.error.message)
  return ok({
    summary: `Metabase with ${databases.value.length} database(s); ${mapped.length} mapped to project databases.`,
  })
}
