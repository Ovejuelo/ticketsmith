import { type DestinationStream, type Logger, pino } from 'pino'

export type { Logger }

export type LoggerOptions = {
  readonly level?: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  /** Defaults to stderr: stdout stays free for CLI output and the MCP protocol. */
  readonly destination?: DestinationStream
}

// Fields that must never reach a log, wherever they appear in the object.
export const REDACTED_PATHS = [
  'token',
  'apiToken',
  'password',
  'secret',
  'authorization',
  'cookie',
  '*.token',
  '*.apiToken',
  '*.password',
  '*.secret',
  '*.authorization',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
]

export const createLogger = ({ level = 'warn', destination }: LoggerOptions = {}): Logger =>
  pino(
    {
      name: 'ticketsmith',
      level,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    destination ?? pino.destination(2),
  )
