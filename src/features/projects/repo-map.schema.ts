import { z } from 'zod'

const CountSchema = z.tuple([z.string(), z.number()])

export const EndpointSchema = z.object({
  method: z.string(),
  path: z.string(),
  file: z.string(),
  line: z.number(),
})
export type Endpoint = z.infer<typeof EndpointSchema>

/** The deterministic map of one repository at one commit (see repo-map.ts). */
export const RepoMapSchema = z.object({
  name: z.string(),
  url: z.string(),
  branches: z.object({ fix: z.string(), feature: z.string() }),
  commit: z.object({ id: z.string(), date: z.string() }),
  runtime: z.string().optional(),
  testCommand: z.string().optional(),
  fileCount: z.number(),
  languages: z.array(CountSchema),
  structure: z.array(CountSchema),
  stack: z.array(z.string()),
  entryPoints: z.array(z.string()),
  endpoints: z.array(EndpointSchema),
  screens: z.array(EndpointSchema),
  calls: z.array(EndpointSchema),
  models: z.array(z.string()),
  migrations: z.array(CountSchema),
  sqlFiles: z.array(z.string()),
  configFiles: z.array(z.string()),
  tests: z.object({ count: z.number(), dirs: z.array(z.string()) }),
})
export type RepoMap = z.infer<typeof RepoMapSchema>

/** What the catalog keeps per repository: the last sync and the map of the commit it mapped. */
export const RepoStateSchema = z.object({
  fetchedAt: z.string(),
  map: RepoMapSchema,
})
export type RepoState = z.infer<typeof RepoStateSchema>
