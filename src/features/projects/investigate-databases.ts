import { type OpenedProject, requireDatabases } from '../../core/cli/index.ts'
import {
  DATABASE_CATALOG,
  type DatabaseSchema,
  describeDatabaseError,
  type TableInfo,
} from '../../core/database/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { removeKnowledge, writeKnowledge } from '../../core/knowledge/index.ts'
import type { DatabaseTarget } from '../../core/project/index.ts'
import type { DatabaseConnections, Services } from '../../core/services/index.ts'
import type { ProjectDatabase } from '../../core/storage/index.ts'
import type { InvestigationOutcome } from './investigate-tickets.ts'

export const DATABASES_KNOWLEDGE_DIR = 'databases'

type Investigated = {
  readonly target: DatabaseTarget
  readonly from: string
  readonly schema: DatabaseSchema
}

/**
 * Introspects each target once (a group shares one schema, so its first reachable member is
 * enough), stores the tables in the local catalog and writes knowledge/databases/<target>.md.
 * Targets that could not be read are reported, and the step fails so onboarding retries them.
 */
export const investigateDatabases = async (
  services: Services,
  opened: OpenedProject,
  db: ProjectDatabase,
): Promise<Result<InvestigationOutcome, string>> => {
  const connections = requireDatabases(services, opened)
  // A refresh rebuilds everything, so removed databases or groups leave nothing stale behind.
  db.clearCatalog(DATABASE_CATALOG.integration)
  await removeKnowledge(opened.paths.knowledgeDir, DATABASES_KNOWLEDGE_DIR)
  const investigated: Investigated[] = []
  const failures: string[] = []
  try {
    for (const target of connections.targets) {
      const result = await introspectTarget(target, (name) => connections.connect(name))
      if (!result.ok) {
        failures.push(`${target.name}: ${result.error}`)
        continue
      }
      investigated.push({ target, ...result.value })
      db.replaceCatalog(
        DATABASE_CATALOG.integration,
        DATABASE_CATALOG.tableKind(target.name),
        result.value.schema.tables.map((table) => ({ key: table.name, data: table })),
      )
      const written = await writeKnowledge(
        opened.paths.knowledgeDir,
        `${DATABASES_KNOWLEDGE_DIR}/${target.name}.md`,
        renderSchemaKnowledge(target, result.value.from, result.value.schema),
        opened.project.masking,
      )
      if (!written.ok) failures.push(`${target.name}: ${written.error.message}`)
    }
  } finally {
    await connections[Symbol.asyncDispose]()
  }

  if (failures.length > 0) return err(failures.join(' | '))
  const tables = investigated.reduce((sum, item) => sum + item.schema.tables.length, 0)
  const targets = investigated.map(({ target }) =>
    target.members.length > 1 ? `${target.name} (${target.members.length} databases)` : target.name,
  )
  return ok({ summary: `${targets.join(', ')}: ${tables} tables` })
}

const introspectTarget = async (
  target: DatabaseTarget,
  connect: (name: string) => ReturnType<DatabaseConnections['connect']>,
): Promise<Result<{ from: string; schema: DatabaseSchema }, string>> => {
  const reasons: string[] = []
  for (const member of target.members) {
    const adapter = await connect(member.name)
    if (!adapter.ok) {
      reasons.push(adapter.error)
      continue
    }
    const schema = await adapter.value.introspect()
    if (schema.ok) return ok({ from: member.name, schema: schema.value })
    reasons.push(describeDatabaseError(schema.error))
  }
  return err(reasons.join('; ') || 'no databases')
}

const relationCount = (table: TableInfo, all: readonly TableInfo[]): number =>
  table.foreignKeys.length +
  all.reduce(
    (sum, other) =>
      sum + other.foreignKeys.filter((fk) => fk.referencesTable === table.name).length,
    0,
  )

const escapeCell = (text: string): string => text.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()

export const renderSchemaKnowledge = (
  target: DatabaseTarget,
  from: string,
  schema: DatabaseSchema,
): string => {
  const members = target.members.map((member) => member.name)
  const hubs = [...schema.tables]
    .map((table) => ({ table, relations: relationCount(table, schema.tables) }))
    .filter((entry) => entry.relations > 0)
    .sort((a, b) => b.relations - a.relations)
    .slice(0, 15)

  const tables = schema.tables.map((table) => {
    const rows =
      table.estimatedRows === null ? '' : ` (~${table.estimatedRows.toLocaleString('en-US')} rows)`
    return [
      `### ${table.name}${rows}`,
      ...(table.comment ? ['', table.comment] : []),
      '',
      '| Column | Type | Null | Key | Comment |',
      '| --- | --- | --- | --- | --- |',
      ...table.columns.map(
        (c) =>
          `| ${c.name} | ${escapeCell(c.type)} | ${c.nullable ? 'yes' : ''} | ${c.key} | ${escapeCell(c.comment)} |`,
      ),
      ...(table.foreignKeys.length > 0
        ? [
            '',
            `Foreign keys: ${table.foreignKeys.map((fk) => `${fk.column} → ${fk.referencesTable}.${fk.referencesColumn}`).join(', ')}`,
          ]
        : []),
    ].join('\n')
  })

  return [
    `# Database schema: ${target.name}`,
    '',
    members.length > 1 || target.members[0]?.group !== undefined
      ? `Group of ${members.length} databases sharing this schema: ${members.join(', ')}. Investigated from ${from}.`
      : `Database ${from}.`,
    `Engine: ${target.members[0]?.type ?? 'unknown'}. ${schema.tables.length} tables. Query it read-only with \`db_select\` / \`db_select_group\`; look tables up with \`db_schema\`.`,
    '',
    '## Most connected tables',
    '',
    hubs.length > 0
      ? hubs.map((h) => `- ${h.table.name} (${h.relations} relations)`).join('\n')
      : '_No foreign keys declared._',
    '',
    '## Tables',
    '',
    tables.join('\n\n'),
    '',
  ].join('\n')
}
