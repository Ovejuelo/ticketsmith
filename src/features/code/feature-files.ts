import type { FeatureDesign } from '../../core/agent/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import type { FeatureQuestion } from './feature-state.schema.ts'

const list = (items: readonly string[], empty = '_None._'): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty

/** questions.md: one section per open question with room for the answer under "Answer:". */
export const renderQuestions = (
  key: string,
  round: number,
  questions: readonly FeatureQuestion[],
): string =>
  [
    `# ${key}: open questions (round ${round})`,
    '',
    `Write each answer under its "Answer:" line (any length), then run \`ticketsmith feature ${key}\`. You can also paste the questions into the ticket for the requester. Keep the "## Q" headings as they are.`,
    '',
    ...questions.flatMap((q) => [
      `## ${q.id}. ${q.question}`,
      '',
      `Why it matters: ${q.why}`,
      '',
      'Answer:',
      '',
      '',
    ]),
  ].join('\n')

/**
 * Reads the answers back from questions.md. Every listed question must still have its section;
 * an empty answer means it is still open.
 */
export const parseAnswers = (
  text: string,
  questions: readonly FeatureQuestion[],
): Result<
  { readonly answers: Readonly<Record<string, string>>; readonly open: readonly FeatureQuestion[] },
  string
> => {
  const sections = new Map<string, string>()
  const headings = [...text.matchAll(/^## (Q\d+)\.[^\n]*$/gm)]
  headings.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = headings[index + 1]?.index ?? text.length
    if (match[1] !== undefined) sections.set(match[1], text.slice(start, end))
  })
  const answers: Record<string, string> = {}
  const open: FeatureQuestion[] = []
  for (const question of questions) {
    const section = sections.get(question.id)
    if (section === undefined) {
      return err(
        `questions.md lost the section of ${question.id}; keep every "## ${question.id}." heading.`,
      )
    }
    const marker = /^Answer:[ \t]*(.*)$/m.exec(section)
    if (marker === null) return err(`questions.md: ${question.id} has no "Answer:" line.`)
    const answer =
      `${marker[1] ?? ''}\n${section.slice((marker.index ?? 0) + marker[0].length)}`.trim()
    if (answer === '') open.push(question)
    else answers[question.id] = answer
  }
  return ok({ answers, open })
}

export const renderSpec = (key: string, design: FeatureDesign, tentative: boolean): string =>
  [
    `# ${key}: spec${tentative ? ' (tentative: open questions remain)' : ''}`,
    '',
    design.spec.summary,
    '',
    '## Understanding',
    '',
    design.understanding,
    '',
    '## Behavior',
    '',
    list(design.spec.behavior),
    '',
    '## Acceptance criteria',
    '',
    design.spec.acceptanceCriteria.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n'),
    '',
    '## Out of scope',
    '',
    list(design.spec.outOfScope),
    '',
    '## Assumptions',
    '',
    list(design.assumptions),
    '',
  ].join('\n')

export const renderPlan = (key: string, design: FeatureDesign, tentative: boolean): string =>
  [
    `# ${key}: plan${tentative ? ' (tentative: open questions remain)' : ''}`,
    '',
    `Approve it with \`ticketsmith feature approve ${key}\`, or reject it with \`ticketsmith feature reject ${key} --feedback "…"\`. No code is written before it is approved.`,
    '',
    ...design.plan.repos.flatMap((repo) => [`## ${repo.repo}`, '', list(repo.changes), '']),
    '## Schema changes (migration files in the repository, never run)',
    '',
    list(design.plan.schemaChanges),
    '',
    '## Tests',
    '',
    list(design.plan.tests),
    '',
    '## Risks',
    '',
    list(design.plan.risks),
    '',
    '## Rollout',
    '',
    design.plan.rollout,
    '',
  ].join('\n')

/** New migration files in a patch: files added under migrations folders, db/migrate, or new .sql files. */
export const newMigrations = (patch: string): readonly string[] =>
  [...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)\nnew file mode/gm)]
    .map((match) => match[1] ?? '')
    .filter((file) => /(^|\/)(migrations?|db\/migrate)\//.test(file) || file.endsWith('.sql'))
