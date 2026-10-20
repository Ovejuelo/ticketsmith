import type { Feature } from '../../core/feature/index.ts'
import { investigateCommand } from './investigate.command.ts'

/** Agent investigations without a ticket: `investigate "<question>"`, read-only. */
export const investigateFeature: Feature = {
  name: 'investigate',
  commands: [investigateCommand],
  tools: [],
}
