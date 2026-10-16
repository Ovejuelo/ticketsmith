import type { StorageError } from './project-database.ts'

export const describeStorageError = (error: StorageError): string =>
  `Local project store problem (${error.path}): ${error.message}. It is a cache: \`ticketsmith project refresh\` rebuilds it.`
