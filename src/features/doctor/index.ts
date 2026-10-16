import type { Feature } from '../../core/feature/index.ts'
import { doctorCommand } from './doctor.command.ts'

/** Health checks for the profile, token and every external system: `doctor`. */
export const doctorFeature: Feature = {
  name: 'doctor',
  commands: [doctorCommand],
  tools: [],
}
