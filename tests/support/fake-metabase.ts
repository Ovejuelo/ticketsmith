import { err, ok, type Result } from '#src/core/kernel/index.ts'
import type {
  MetabaseClient,
  MetabaseDatabase,
  MetabaseError,
  NativeCard,
} from '#src/core/metabase/index.ts'

/** An in-memory Metabase: records the connections and the cards it was asked to create. */
export class FakeMetabase implements MetabaseClient {
  readonly connections: { url: string; apiKey: string }[] = []
  readonly cards: NativeCard[] = []
  list: readonly MetabaseDatabase[] = [
    { id: 3, name: 'Billing shard 1', engine: 'mysql' },
    { id: 4, name: 'Ledger', engine: 'postgres' },
  ]
  failure: MetabaseError | null = null

  connect(url: string, apiKey: string): MetabaseClient {
    this.connections.push({ url, apiKey })
    return this
  }

  async currentUser(): Promise<Result<{ readonly name: string }, MetabaseError>> {
    return this.failure === null ? ok({ name: 'API key' }) : err(this.failure)
  }

  async databases(): Promise<Result<readonly MetabaseDatabase[], MetabaseError>> {
    return this.failure === null ? ok(this.list) : err(this.failure)
  }

  async createCard(
    card: NativeCard,
  ): Promise<Result<{ readonly id: number; readonly url: string }, MetabaseError>> {
    if (this.failure !== null) return err(this.failure)
    this.cards.push(card)
    const id = 100 + this.cards.length
    return ok({ id, url: `https://metabase.example.com/question/${id}` })
  }
}
