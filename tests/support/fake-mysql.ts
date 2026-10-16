import type {
  MysqlConnection,
  MysqlConnectionSource,
} from '#src/core/database/providers/mysql/index.ts'

type Reply = readonly [unknown, unknown] | Error

const mysqlError = (message: string, props: { code?: string; errno?: number }): Error =>
  Object.assign(new Error(message), props)

export const mysqlErrors = {
  refused: () => mysqlError('connect ECONNREFUSED', { code: 'ECONNREFUSED' }),
  auth: () =>
    mysqlError("Access denied for user 'x'", { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 }),
  timeout: () =>
    mysqlError('Query execution was interrupted', { code: 'ER_QUERY_TIMEOUT', errno: 3024 }),
  readOnly: () =>
    mysqlError('Cannot execute statement in a READ ONLY transaction.', {
      code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
      errno: 1792,
    }),
}

/** Records every statement and answers by the first matching pattern (default: no rows). */
export class FakeMysql implements MysqlConnectionSource {
  readonly statements: string[] = []
  readonly #replies: { pattern: RegExp; reply: Reply }[] = []
  connectError: Error | null = null
  released = 0
  ended = false

  on(pattern: RegExp, reply: Reply): this {
    this.#replies.push({ pattern, reply })
    return this
  }

  rows(pattern: RegExp, rows: readonly Record<string, unknown>[]): this {
    const fields = rows[0] === undefined ? [] : Object.keys(rows[0]).map((name) => ({ name }))
    return this.on(pattern, [rows, fields])
  }

  async getConnection(): Promise<MysqlConnection> {
    if (this.connectError !== null) throw this.connectError
    return {
      query: async ({ sql }) => {
        this.statements.push(sql)
        const reply = this.#replies.find((entry) => entry.pattern.test(sql))?.reply ?? [[], []]
        if (reply instanceof Error) throw reply
        return [reply[0], reply[1]]
      },
      release: () => {
        this.released++
      },
    }
  }

  async end(): Promise<void> {
    this.ended = true
  }
}
