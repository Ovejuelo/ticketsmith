import type { TicketSourceError } from './ticket-source.port.ts'

/** Human-readable message with a next step, shared by the CLI and the MCP tools. */
export const describeTicketSourceError = (error: TicketSourceError): string => {
  switch (error.kind) {
    case 'unauthorized':
      return `JIRA rejected the credentials (${error.message}). Check them with \`ticketsmith doctor\` or run \`ticketsmith init\` again.`
    case 'forbidden':
      return `JIRA denied access (${error.message}). The token may lack a scope or project permission.`
    case 'not-found':
      return `Not found: ${error.key}. It may not exist, or this token cannot see it.`
    case 'rate-limited':
      return error.retryAfterMs === null
        ? 'JIRA rate limit reached. Try again later.'
        : `JIRA rate limit reached. Try again in ${Math.ceil(error.retryAfterMs / 1000)} s.`
    case 'invalid-query':
      return `JIRA rejected the request: ${error.message}`
    case 'network':
      return `Could not reach JIRA: ${error.message}`
    case 'invalid-response':
      return `Unexpected response from JIRA: ${error.message}`
  }
}
