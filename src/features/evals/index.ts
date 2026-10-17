import type { Feature } from '../../core/feature/index.ts'
import { evalCommand } from './eval.command.ts'

/** Evaluations on resolved tickets: `eval add <KEY>` and `eval [--full]`. */
export const evalsFeature: Feature = {
  name: 'evals',
  commands: [evalCommand],
  tools: [],
}
