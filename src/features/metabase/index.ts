import type { Feature } from '../../core/feature/index.ts'
import { metabaseCommand } from './metabase.command.ts'

/** Report queries become Metabase questions: `metabase publish`. */
export const metabaseFeature: Feature = {
  name: 'metabase',
  commands: [metabaseCommand],
  tools: [],
}
