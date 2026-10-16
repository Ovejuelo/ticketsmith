import { AppError } from '../kernel/index.ts'

export type Io = {
  out(text: string): void
  err(text: string): void
  /** True when both stdin and stdout are terminals, so prompts are allowed. */
  readonly interactive: boolean
  readonly columns: number
}

/** A user-facing failure: main.ts prints the message and exits with code 1. */
export class CliError extends AppError {
  constructor(message: string) {
    super('CLI_FAILED', message)
  }
}

export function fail(message: string): never {
  throw new CliError(message)
}
