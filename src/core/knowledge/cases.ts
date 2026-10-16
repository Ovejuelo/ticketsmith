import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'
import type { MaskingOptions } from '../security/index.ts'
import { writeKnowledge } from './write-knowledge.ts'

export const CASES_DIR = 'cases'

const read = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** The body of a "## Heading" section of a Markdown file. */
export const sectionOf = (markdown: string, heading: string): string | null => {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  if (start === -1) return null
  const rest = markdown.slice(start + heading.length + 5)
  const end = rest.search(/\n## /)
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null
}

const json = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * A resolved case from what Ticketsmith left in out/<KEY>/: the classification, the analysis, the
 * code or feature summary, approved data changes and pull requests, plus the person's note on how
 * it was resolved. Written later through writeKnowledge, which masks it.
 */
export const buildCase = async (
  outDir: string,
  key: string,
  note: string | undefined,
): Promise<Result<{ markdown: string; type: string }, string>> => {
  const dir = join(outDir, key)
  const classification = json(await read(join(dir, 'classification.json')))
  const analysis = await read(join(dir, 'analysis.md'))
  const code = await read(join(dir, 'code', 'summary.md'))
  const codeRun = json(await read(join(dir, 'code', 'run.json')))
  const spec = await read(join(dir, 'feature', 'spec.md'))
  const featureRun = json(await read(join(dir, 'feature', 'code', 'run.json')))
  const changeDirs = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.startsWith('change-cr-'),
  )
  const changes: string[] = []
  for (const name of changeDirs.sort()) {
    const sql = await read(join(dir, name, 'change.sql'))
    const result = json(await read(join(dir, name, 'result.json')))
    if (sql !== null) changes.push(`${sql.trim()}\n-- ${String(result?.['status'] ?? 'unknown')}`)
  }
  if (
    [classification, analysis, code, spec].every((part) => part === null) &&
    changes.length === 0 &&
    note === undefined
  ) {
    return err(
      `Nothing in out/${key}/ to build a case from yet: run process, code or feature first, or pass --note.`,
    )
  }

  const type =
    typeof classification?.['type'] === 'string' ? classification['type'] : 'unclassified'
  const pullRequests = [codeRun, featureRun].flatMap((run) =>
    Array.isArray(run?.['repos'])
      ? (run['repos'] as Record<string, unknown>[]).flatMap((repo) =>
          typeof repo['pullRequest'] === 'string'
            ? [`- ${String(repo['repo'])}: ${repo['pullRequest']}`]
            : [],
        )
      : [],
  )
  const markdown = [
    '---',
    `ticket: ${key}`,
    `type: ${type}`,
    `classifiedBy: ${String(classification?.['source'] ?? 'none')}`,
    `savedAt: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
    `# ${key}: resolved case`,
    '',
    ...(classification === null
      ? []
      : [
          '## Classification',
          '',
          `${type} (${String(classification['confidence'])}, by ${String(classification['source'])}): ${String(classification['reason'] ?? '')}`,
          '',
        ]),
    ...(analysis === null
      ? []
      : [
          '## Investigation',
          '',
          sectionOf(analysis, 'Summary') ?? '',
          '',
          `**Probable cause:** ${sectionOf(analysis, 'Probable cause') ?? 'not stated'}`,
          '',
        ]),
    ...(code === null
      ? []
      : [
          '## Code fix',
          '',
          sectionOf(code, 'Summary') ?? '',
          '',
          `**Root cause:** ${sectionOf(code, 'Root cause') ?? 'not stated'}`,
          '',
        ]),
    ...(spec === null
      ? []
      : [
          '## New functionality',
          '',
          spec.split('\n').slice(2).join('\n').split('\n## ')[0]?.trim() ?? '',
          '',
        ]),
    ...(changes.length === 0
      ? []
      : ['## Data changes', '', ...changes.map((change) => `\`\`\`sql\n${change}\n\`\`\``), '']),
    ...(pullRequests.length === 0 ? [] : ['## Pull requests', '', ...pullRequests, '']),
    ...(note === undefined ? [] : ['## How it was resolved', '', note.trim(), '']),
  ].join('\n')
  return ok({ markdown, type })
}

export const saveCase = async (
  knowledgeDir: string,
  outDir: string,
  key: string,
  note: string | undefined,
  masking: MaskingOptions,
): Promise<Result<string, string>> => {
  const built = await buildCase(outDir, key, note)
  if (!built.ok) return built
  const file = `${CASES_DIR}/${key}.md`
  const written = await writeKnowledge(knowledgeDir, file, built.value.markdown, masking)
  return written.ok ? ok(file) : err(written.error.message)
}
