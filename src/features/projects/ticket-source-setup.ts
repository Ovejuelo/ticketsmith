import { askConfirm, fail, type Io, orFail, spinner } from '../../core/cli/index.ts'
import {
  describeProjectError,
  type JiraAuthKind,
  normalizeSiteUrl,
  type Project,
} from '../../core/project/index.ts'
import { describeSecretError, secretEnvVariable } from '../../core/secrets/index.ts'
import type { Services } from '../../core/services/index.ts'
import { connectTicketSource, type JiraDeployment } from './connect-ticket-source.ts'
import { runDiscover } from './discover-jira.ts'
import { askJiraConnection } from './jira-prompts.ts'

export type JiraFlags = {
  readonly deployment?: JiraDeployment
  readonly site?: string
  readonly email?: string
  readonly auth?: JiraAuthKind
  readonly allowWrites?: boolean
}

/** Scripted setup: every JIRA flag is required and the token comes from the environment. */
export const addTicketSourceFromFlags = async (
  services: Services,
  project: Project,
  flags: JiraFlags,
): Promise<Project> => {
  const { site, email, auth } = flags
  const dataCenter = flags.deployment === 'data-center'
  if (dataCenter ? !site : !site || !email || !auth) {
    fail(
      dataCenter
        ? 'A Data Center ticket source needs --site.'
        : 'A ticket source needs --site, --email and --auth (or --deployment data-center).',
    )
  }
  const token = orFail(await services.loadSecret(project.name, 'jira-token'), describeSecretError)
  if (token === null) fail(`Set ${secretEnvVariable('jira-token')} to add a ticket source.`)
  const siteUrl = orFail(normalizeSiteUrl(site ?? '', { keepPath: dataCenter }), String)
  const { project: updated } = await connectTicketSource(
    services,
    project,
    dataCenter
      ? {
          deployment: 'data-center',
          siteUrl,
          token: token.value,
          allowWrites: flags.allowWrites,
        }
      : {
          siteUrl,
          email: email ?? '',
          auth: auth ?? 'scoped',
          token: token.value,
          allowWrites: flags.allowWrites,
        },
    { storeToken: token.source !== 'environment' },
  )
  return updated
}

/**
 * Interactive setup: asks for the connection (or offers to keep the current one), verifies it
 * with a spinner, then offers to pick the JIRA project and board. Returns the saved project and
 * whether anything changed, so the caller knows to re-investigate.
 */
export const configureTicketSourceInteractively = async (
  services: Services,
  io: Io,
  project: Project,
): Promise<{ readonly project: Project; readonly changed: boolean }> => {
  const current = project.integrations.tickets
  let updated = project
  let changed = false

  if (current === undefined || (await askConfirm('Update the JIRA connection details?', false))) {
    const input = await askJiraConnection(current)
    const progress = spinner()
    progress.start('Verifying the JIRA connection')
    try {
      const connected = await connectTicketSource(services, project, input, { storeToken: true })
      progress.stop(`Connected as ${connected.identity.displayName}`)
      updated = connected.project
      changed = true
    } catch (error) {
      progress.stop('Verification failed')
      throw error
    }
  }

  const tickets = updated.integrations.tickets
  const allowWrites = await askConfirm(
    tickets?.type === 'jira-data-center'
      ? 'Allow posting comments and transitions from the CLI? You read and confirm each one; your account needs those permissions.'
      : 'Allow posting comments and transitions from the CLI? You read and confirm each one; the token needs write:jira-work.',
    tickets?.allowWrites ?? false,
  )
  if (tickets !== undefined && allowWrites !== tickets.allowWrites) {
    updated = {
      ...updated,
      integrations: { ...updated.integrations, tickets: { ...tickets, allowWrites } },
    }
    orFail(await services.projects.save(updated), describeProjectError)
  }

  if (await askConfirm('Pick the JIRA project and board now?', current?.projectKey === undefined)) {
    await runDiscover(services, io, { project: updated.name, fields: false })
    changed = true
  }
  return { project: updated, changed }
}
