import type { OutputError } from './ticket-output.ts'

export const describeOutputError = (error: OutputError): string =>
  `Could not write to ${error.path}: ${error.message}`
