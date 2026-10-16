/** Base class for unexpected errors. Expected ones are modeled as `Result`. */
export class AppError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIG_INVALID', message, options)
  }
}
