import type { Feature } from '../../core/feature/index.ts'
import { codeCommand } from './code.command.ts'
import { diffTool } from './diff.tool.ts'
import { runTestsTool } from './run-tests.tool.ts'

/** Code changes per ticket (L3): `code <KEY>|push|status|discard`, and code_run_tests/code_diff for the agent. */
export const codeFeature: Feature = {
  name: 'code',
  commands: [codeCommand],
  tools: [runTestsTool, diffTool],
}
