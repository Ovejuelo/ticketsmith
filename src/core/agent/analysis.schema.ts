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
