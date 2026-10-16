import type { Feature } from '../../core/feature/index.ts'
import { processCommand } from './process.command.ts'

/** End-to-end ticket processing with the agent: `process <KEY>` and `process --next`. */
export const processFeature: Feature = {
  name: 'process',
  commands: [processCommand],
  tools: [],
}
