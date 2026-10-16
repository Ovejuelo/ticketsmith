import type { Feature } from '../../core/feature/index.ts'
import { classifyCommand } from './classify.command.ts'

/** `classify <KEY>`: rules, then the LLM, then a person when both are unsure. */
export const classifyFeature: Feature = {
  name: 'classify',
  commands: [classifyCommand],
  tools: [],
}
