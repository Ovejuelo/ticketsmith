import type { DatabaseError } from './database-adapter.port.ts'

export const describeDatabaseError = (error: DatabaseError): string => {
  switch (error.kind) {
    case 'unreachable':
      return `Database "${error.database}" is unreachable (${error.message}). Is the VPN or tunnel up?`
    case 'auth':
      return `Database "${error.database}" rejected the credentials (${error.message}). Update them with \`ticketsmith project add databases\`.`
    case 'timeout':
      return `The query on "${error.database}" took longer than ${error.seconds} s and was stopped. Narrow it (filters on indexed columns, smaller LIMIT).`
    case 'rejected-by-database':
      return `"${error.database}" refused the statement inside the read-only transaction: ${error.message}`
    case 'query':
      return `Query failed on "${error.database}": ${error.message}`
  }
}
