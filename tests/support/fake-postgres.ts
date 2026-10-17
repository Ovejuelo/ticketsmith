import type {
  PostgresClient,
  PostgresConnectionSource,
  PostgresQueryResult,
} from '#src/core/database/providers/postgres/index.ts'

type Reply = PostgresQueryResult | Error

const pgError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })

export const postgresErrors = {
  refused: () => pgError('connect ECONNREFUSED', 'ECONNREFUSED'),
  auth: () => pgError('password authentication failed for user "x"', '28P01'),
  timeout: () => pgError('canceling statement due to statement timeout', '57014'),
  readOnly: () => pgError('cannot execute INSERT in a read-only transaction', '25006'),
}

export const pgRows = (
  rows: readonly Record<string, unknown>[],
  rowCount: number | null = rows.length,
): PostgresQueryResult => ({
  rows,
  fields: rows[0] === undefined ? [] : Object.keys(rows[0]).map((name) => ({ name })),
  rowCount,
})

/** Records every statement (and whether it used the extended protocol); answers by pattern. */
export class FakePostgres implements PostgresConnectionSource {
  readonly statements: string[] = []
  readonly extended: boolean[] = []
  readonly #replies: { pattern: RegExp; reply: Reply }[] = []
  connectError: Error | null = null
  released = 0
  ended = false

  on(pattern: RegExp, reply: Reply): this {
    this.#replies.push({ pattern, reply })
    return this
  }

  async connect(): Promise<PostgresClient> {
    if (this.connectError !== null) throw this.connectError
    return {
      query: async ({ text, queryMode }) => {
        this.statements.push(text)
        this.extended.push(queryMode === 'extended')
        const reply = this.#replies.find((entry) => entry.pattern.test(text))?.reply ?? pgRows([])
        if (reply instanceof Error) throw reply
        return reply
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
