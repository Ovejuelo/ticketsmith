import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/core/kernel/index.ts'
import { TicketKeySchema } from '#src/core/tickets/index.ts'
import { JiraCloudTicketWriter } from '#src/core/tickets/providers/jira-cloud/jira-cloud-ticket-writer.ts'
import { JiraHttpClient } from '#src/core/tickets/providers/jira-cloud/jira-http-client.ts'
import { FakeFetch } from '#tests/support/fake-fetch.ts'

const KEY = TicketKeySchema.parse('OPS-7')

const writerWith = (http: FakeFetch) =>
  new JiraCloudTicketWriter(
    new JiraHttpClient({
      baseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
      email: 'me@acme.test',
      token: 't',
      logger: createLogger({ level: 'silent' }),
      fetch: http.fetch,
      sleep: async () => {},
    }),
    'https://acme.atlassian.net',
  )

describe('JiraCloudTicketWriter', () => {
  it('posts comments as ADF and links to them', async () => {
    const http = new FakeFetch().on('/issue/OPS-7/comment', { status: 201, body: { id: '10042' } })
    const result = await writerWith(http).addComment(KEY, 'Hola **equipo**')
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://acme.atlassian.net/browse/OPS-7?focusedCommentId=10042' },
    })
    const [request] = http.requests
    expect(request?.method).toBe('POST')
    expect(request?.body).toEqual({
      body: {
        version: 1,
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hola ' },
              { type: 'text', text: 'equipo', marks: [{ type: 'strong' }] },
            ],
          },
        ],
      },
    })
  })

  it('never retries a write, even on a 5xx', async () => {
    const http = new FakeFetch().on('/issue/OPS-7/comment', {
      status: 503,
      body: { errorMessages: ['busy'] },
    })
    expect((await writerWith(http).addComment(KEY, 'x')).ok).toBe(false)
    expect(http.requests).toHaveLength(1)
  })

  it('lists and applies transitions, and reads permissions', async () => {
    const http = new FakeFetch()
      .on(
        '/issue/OPS-7/transitions',
        { body: { transitions: [{ id: '31', name: 'Resolve', to: { name: 'Done' } }] } },
        { status: 204 },
      )
      .on('/mypermissions', {
        body: {
          permissions: {
            ADD_COMMENTS: { havePermission: true },
            TRANSITION_ISSUES: { havePermission: false },
          },
        },
      })
    const writer = writerWith(http)
    expect(await writer.transitions(KEY)).toEqual({
      ok: true,
      value: [{ id: '31', name: 'Resolve', to: 'Done' }],
    })
    expect(await writer.transition(KEY, '31')).toEqual({ ok: true, value: undefined })
    expect(http.requests[1]?.body).toEqual({ transition: { id: '31' } })
    expect(await writer.permissions()).toEqual({
      ok: true,
      value: { addComments: true, transitionIssues: false },
    })
    expect(http.requests[2]?.url.searchParams.get('permissions')).toBe(
      'ADD_COMMENTS,TRANSITION_ISSUES',
    )
  })

  it('reports missing write permission', async () => {
    const http = new FakeFetch().on('/issue/OPS-7/comment', {
      status: 403,
      body: { errorMessages: ['You do not have permission'] },
    })
    expect(await writerWith(http).addComment(KEY, 'x')).toEqual({
      ok: false,
      error: { kind: 'forbidden', message: 'You do not have permission' },
    })
  })
})
