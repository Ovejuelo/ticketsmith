import type { Feature } from '../../core/feature/index.ts'
import { codeCommand } from './code.command.ts'
import { diffTool } from './diff.tool.ts'
import { featureCommand } from './feature.command.ts'
import { runTestsTool } from './run-tests.tool.ts'

/** Code per ticket: fixes (`code`), new functionality with a design checkpoint (`feature`), and code_run_tests/code_diff for the agent. */
export const codeFeature: Feature = {
  name: 'code',
  commands: [codeCommand, featureCommand],
  tools: [runTestsTool, diffTool],
}
