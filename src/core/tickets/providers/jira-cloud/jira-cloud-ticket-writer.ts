import { z } from 'zod'
import { err, ok, type Result } from '../../../kernel/index.ts'
import { markdownToAdf } from '../../adf/markdown-to-adf.ts'
import type { TicketKey } from '../../ticket.schema.ts'
import type { TicketSourceError } from '../../ticket-source.port.ts'
import type { TicketTransition, TicketWriter } from '../../ticket-writer.port.ts'
import type { JiraHttpClient } from './jira-http-client.ts'

const CreatedCommentSchema = z.object({ id: z.string() })
const TransitionsSchema = z.object({
  transitions: z.array(
    z.object({ id: z.string(), name: z.string(), to: z.object({ name: z.string() }) }),
  ),
})
const PermissionsSchema = z.object({
  permissions: z.record(z.string(), z.object({ havePermission: z.boolean() })),
})

/** JIRA Cloud writes: comments as ADF, transitions by id. */
export class JiraCloudTicketWriter implements TicketWriter {
  readonly #client: JiraHttpClient
  readonly #siteUrl: string

  constructor(client: JiraHttpClient, siteUrl: string) {
    this.#client = client
    this.#siteUrl = siteUrl.replace(/\/+$/, '')
  }

  async addComment(
    key: TicketKey,
    markdown: string,
  ): Promise<Result<{ readonly url: string }, TicketSourceError>> {
    const created = await this.#client.post(
      `/rest/api/3/issue/${key}/comment`,
      { body: markdownToAdf(markdown) },
      CreatedCommentSchema,
    )
    if (!created.ok) return created
    if (created.value === null)
      return err({ kind: 'invalid-response', message: 'JIRA returned no comment id' })
    return ok({ url: `${this.#siteUrl}/browse/${key}?focusedCommentId=${created.value.id}` })
  }

  async transitions(
    key: TicketKey,
  ): Promise<Result<readonly TicketTransition[], TicketSourceError>> {
    const result = await this.#client.get(
      `/rest/api/3/issue/${key}/transitions`,
      {},
      TransitionsSchema,
    )
    if (!result.ok) return result
    return ok(result.value.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name })))
  }

  async transition(key: TicketKey, transitionId: string): Promise<Result<void, TicketSourceError>> {
    const result = await this.#client.post(
      `/rest/api/3/issue/${key}/transitions`,
      { transition: { id: transitionId } },
      null,
    )
    return result.ok ? ok(undefined) : result
  }

  async permissions(): Promise<
    Result<{ readonly addComments: boolean; readonly transitionIssues: boolean }, TicketSourceError>
  > {
    const result = await this.#client.get(
      '/rest/api/3/mypermissions',
      { permissions: 'ADD_COMMENTS,TRANSITION_ISSUES' },
      PermissionsSchema,
    )
    if (!result.ok) return result
    const has = (name: string) => result.value.permissions[name]?.havePermission ?? false
    return ok({ addComments: has('ADD_COMMENTS'), transitionIssues: has('TRANSITION_ISSUES') })
  }
}
