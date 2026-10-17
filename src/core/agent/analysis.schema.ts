import { z } from 'zod'

const text = (description: string) => z.string().min(1).describe(description)

export const EvidenceSchema = z.object({
  source: z.enum(['ticket', 'database', 'code', 'knowledge']),
  reference: text(
    'Where it comes from: ticket field or comment, the SQL query, repo/file:line, or knowledge file',
  ),
  finding: text('What it shows, in one or two sentences'),
})

/** The answer of a ticket investigation (playbooks such as `bug`). */
export const TicketAnalysisSchema = z.object({
  summary: text('What the ticket asks and what you found, in two or three sentences'),
  ticketType: text('bug, service request, report, new functionality or other'),
  probableCause: text('The most likely cause, or "unknown" with why'),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(EvidenceSchema).describe('Every fact the conclusion rests on'),
  nextSteps: z.array(z.string().min(1)).describe('What to do next, in order'),
  openQuestions: z
    .array(z.string().min(1))
    .describe('What is still unknown and who could answer it'),
  jiraComment: text('A reply for the ticket, ready to paste, in the language of the ticket'),
  suggestedTransition: z
    .string()
    .min(1)
    .optional()
    .describe('The status the ticket should move to next, if any (a person applies it)'),
})
export type TicketAnalysis = z.infer<typeof TicketAnalysisSchema>

/** The answer of a deep repository analysis (playbook `repo-analysis`). */
export const RepoAnalysisSchema = z.object({
  overview: text('What the application does and how it is built, in one paragraph'),
  modules: z
    .array(z.object({ path: text('Folder or file'), purpose: text('What it is responsible for') }))
    .describe('The main modules'),
  flows: z
    .array(
      z.object({
        name: text('A user-visible flow, e.g. "deactivate an account"'),
        steps: z.array(z.string().min(1)).describe('Each step with its repo/file:line'),
      }),
    )
    .describe('The most important flows, end to end'),
  businessRules: z.array(z.string().min(1)).describe('Rules the code enforces, with file:line'),
  dataModel: text('Main entities, how they relate and where they are defined'),
  risks: z.array(z.string().min(1)).describe('Fragile or surprising spots worth knowing'),
  glossary: z
    .array(z.object({ term: text('Domain term'), meaning: text('What it means here') }))
    .describe('Domain vocabulary found in the code'),
})
export type RepoAnalysis = z.infer<typeof RepoAnalysisSchema>

/** The answer of a code change (playbook `code-fix`). */
export const CodeChangeSchema = z.object({
  summary: text('What was wrong and what you changed, in two or three sentences'),
  rootCause: text('The cause in the code, with repo/file:line'),
  changes: z
    .array(
      z.object({
        repo: text('Repository'),
        file: text('File path'),
        what: text('What changed there'),
      }),
    )
    .describe('Every file you changed'),
  testsAdded: z.array(z.string().min(1)).describe('Tests you added or changed (file and name)'),
  testsPassed: z.boolean().describe('Whether code_run_tests passed after the change'),
  risks: z.array(z.string().min(1)).describe('What could break or still needs a human check'),
  prTitle: z
    .string()
    .min(1)
    .max(100)
    .describe('Pull request title, e.g. "fix(OPS-123): reject expired cards"'),
  prDescription: text('Pull request description in Markdown, for a reviewer; no customer data'),
})
export type CodeChange = z.infer<typeof CodeChangeSchema>

/** The answer of a feature design run (playbook `feature-design`): understanding, spec and plan. */
export const FeatureDesignSchema = z.object({
  understanding: text('What is being asked, why, and for whom, in your own words'),
  assumptions: z
    .array(z.string().min(1))
    .describe('What you assumed because the ticket does not say'),
  questions: z
    .array(
      z.object({
        question: text('A question the requester must answer'),
        why: text('What it changes in the design'),
      }),
    )
    .describe('Open questions that block the design; empty when there are none'),
  spec: z.object({
    summary: text('The functionality in two or three sentences, in terms the requester recognizes'),
    behavior: z.array(z.string().min(1)).describe('Expected behavior, one statement each'),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).describe('Testable criteria, one each'),
    outOfScope: z.array(z.string().min(1)).describe('What this does not include'),
  }),
  plan: z.object({
    repos: z
      .array(
        z.object({
          repo: text('Repository'),
          changes: z
            .array(z.string().min(1))
            .describe('Endpoints, models, screens… to add or change, with paths'),
        }),
      )
      .describe('Changes per repository'),
    schemaChanges: z
      .array(z.string().min(1))
      .describe('Database schema changes, as migration files to add (never run)'),
    tests: z.array(z.string().min(1)).describe('Tests to add, per acceptance criterion'),
    risks: z.array(z.string().min(1)),
    rollout: text('How to release it: order across repositories, migrations, flags, communication'),
  }),
})
export type FeatureDesign = z.infer<typeof FeatureDesignSchema>

/** The answer of implementing an approved feature plan (playbook `feature-implement`). */
export const FeatureImplementationSchema = CodeChangeSchema.extend({
  acceptanceCriteria: z
    .array(
      z.object({
        criterion: text('The criterion as written in the spec'),
        met: z.boolean(),
        evidence: text('The test or code that shows it'),
      }),
    )
    .describe('Every acceptance criterion of the spec'),
  migrations: z
    .array(z.string().min(1))
    .describe('Migration files you added (repo/path), never run'),
})
export type FeatureImplementation = z.infer<typeof FeatureImplementationSchema>
