import type { Feature } from '../core/feature/index.ts'
import { changesFeature } from '../features/changes/index.ts'
import { codeFeature } from '../features/code/index.ts'
import { databasesFeature } from '../features/databases/index.ts'
import { doctorFeature } from '../features/doctor/index.ts'
import { knowledgeFeature } from '../features/knowledge/index.ts'
import { mcpFeature } from '../features/mcp/index.ts'
import { processFeature } from '../features/process/index.ts'
import { projectsFeature } from '../features/projects/index.ts'
import { reposFeature } from '../features/repos/index.ts'
import { ticketsFeature } from '../features/tickets/index.ts'

/** Every feature of Ticketsmith. Adding one = a folder in src/features/ + one line here. */
export const FEATURES: readonly Feature[] = [
  projectsFeature,
  doctorFeature,
  ticketsFeature,
  processFeature,
  codeFeature,
  databasesFeature,
  changesFeature,
  reposFeature,
  knowledgeFeature,
  mcpFeature,
]
