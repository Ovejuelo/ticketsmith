export type FakeReply =
  | { readonly status?: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | Error

export type RecordedRequest = {
  readonly url: URL
  readonly headers: Headers
  readonly method: string
  readonly body: unknown
}

/**
 * Scripted fetch: replies are queued per pathname suffix and consumed in order; the last reply
 * repeats. Unknown routes fail loudly so tests never hit the network by accident.
 */
export class FakeFetch {
  readonly requests: RecordedRequest[] = []
  readonly #routes = new Map<string, FakeReply[]>()

  on(pathSuffix: string, ...replies: FakeReply[]): this {
    this.#routes.set(pathSuffix, replies)
    return this
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    this.requests.push({
      url,
      headers: new Headers(init.headers),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })

    const route = [...this.#routes.keys()]
      .filter((suffix) => url.pathname.endsWith(suffix))
      .sort((a, b) => b.length - a.length)[0]
    const queue = route === undefined ? undefined : this.#routes.get(route)
    if (queue === undefined || queue.length === 0) {
      throw new Error(`FakeFetch: no reply for ${url.pathname}`)
    }

    const reply = queue.length > 1 ? queue.shift() : queue[0]
    if (reply instanceof Error) throw reply
    return new Response(reply?.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply?.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply?.headers },
    })
  }

  pathsRequested(): string[] {
    return this.requests.map((request) => request.url.pathname)
  }
}

export const instantSleep = async (): Promise<void> => {}
