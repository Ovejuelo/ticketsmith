import type { Feature } from '../../core/feature/index.ts'
import { changesCommand } from './changes.command.ts'

/** Human decisions on proposed database changes: `changes list|show|approve|reject`. */
export const changesFeature: Feature = {
  name: 'changes',
  commands: [changesCommand],
  tools: [],
}
