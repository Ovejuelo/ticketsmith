import { z } from 'zod'
import { fail, orFail } from '../../core/cli/index.ts'
import {
  describeProjectError,
  type JiraAuthKind,
  type Project,
  ProjectSchema,
} from '../../core/project/index.ts'
import { describeSecretError } from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'
import { describeTicketSourceError, type SourceIdentity } from '../../core/tickets/index.ts'

export type JiraConnectionInput = {
  readonly siteUrl: string
  readonly email: string
  readonly auth: JiraAuthKind
  readonly token: string
}

export type ConnectedTicketSource = {
  readonly project: Project
  readonly identity: SourceIdentity
}

/** A project with no integrations yet; integrations are added one by one. */
export const emptyProject = (name: string): Project =>
  ProjectSchema.parse({ version: 2, name, integrations: {} })

/**
 * Adds (or replaces) the project's JIRA ticket source. Verifies the credentials before
 * persisting anything, then stores the token and saves the project. Reconnecting to the same
 * site keeps the previous discovery settings (JIRA project, board, JQL, custom fields).
 */
export const connectTicketSource = async (
  services: Services,
  project: Project,
  input: JiraConnectionInput,
  options: { readonly storeToken: boolean },
): Promise<ConnectedTicketSource> => {
  const previous = project.integrations.tickets
  const kept = previous?.siteUrl === input.siteUrl ? previous : undefined

  const cloudId =
    input.auth === 'scoped'
      ? orFail(await services.resolveCloudId(input.siteUrl), describeTicketSourceError)
      : undefined

  const parsed = ProjectSchema.safeParse({
    ...project,
    integrations: {
      ...project.integrations,
      tickets: {
        type: 'jira-cloud',
        siteUrl: input.siteUrl,
        email: input.email,
        auth: input.auth,
        cloudId,
        projectKey: kept?.projectKey,
        boardId: kept?.boardId,
        jql: kept?.jql,
        customFields: kept?.customFields ?? {},
      },
    },
  })
  if (!parsed.success) fail(`Invalid ticket source:\n${z.prettifyError(parsed.error)}`)
  const updated = parsed.data
  const tickets = updated.integrations.tickets ?? fail('Ticket source was not set.')

  const identity = orFail(
    await services.connectTickets(tickets, input.token).source.verifyConnection(),
    describeTicketSourceError,
  )
  if (options.storeToken) {
    orFail(await services.saveSecret(updated.name, 'jira-token', input.token), describeSecretError)
  }
  orFail(await services.projects.save(updated), describeProjectError)
  return { project: updated, identity }
}
