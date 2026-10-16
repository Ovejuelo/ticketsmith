import type { ProjectStoreError } from './project-store.ts'

/** Human-readable messages with a next step, shared by every feature. */
export const describeProjectError = (error: ProjectStoreError): string => {
  switch (error.kind) {
    case 'not-found':
      return `Project not found (${error.path}). Run \`ticketsmith project list\` or \`ticketsmith project init\`.`
    case 'invalid':
      return `Invalid configuration in ${error.path}:\n${error.issues}`
    case 'no-active-project':
      return 'No project selected. Run `ticketsmith project init`, pass `--project <name>` or run `ticketsmith project use <name>`.'
    case 'io':
      return `Could not access ${error.path}: ${error.message}`
  }
}
