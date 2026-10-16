import type { Project, ProjectPaths, TicketSourceConfig } from '../project/index.ts'
import { describeProjectError } from '../project/index.ts'
import { describeSecretError } from '../secrets/index.ts'
import { DatabaseConnections, type Services, type TicketsConnection } from '../services/index.ts'
import { orFail } from './command.ts'
import { fail } from './io.ts'

export type OpenedProject = {
  readonly project: Project
  readonly paths: ProjectPaths
}

/** Resolves the project (--project > TICKETSMITH_PROJECT > active) and loads it. */
export const openProject = async (
  services: Services,
  explicitProject: string | undefined,
): Promise<OpenedProject> => {
  const name = orFail(
    await services.projects.resolveProjectName(explicitProject),
    describeProjectError,
  )
  const project = orFail(await services.projects.load(name), describeProjectError)
  const paths = orFail(await services.projects.locate(name), describeProjectError)
  return { project, paths }
}

export type ConnectedTickets = TicketsConnection & {
  readonly config: TicketSourceConfig
  readonly tokenSource: string
}

export const NO_TICKET_SOURCE =
  'This project has no ticket source. Add one with `ticketsmith project add tickets`.'

/** Connects the project's ticket source, or explains how to add one. */
export const requireTickets = async (
  services: Services,
  { project }: OpenedProject,
): Promise<ConnectedTickets> => {
  const config = project.integrations.tickets ?? fail(NO_TICKET_SOURCE)
  const token = orFail(await services.loadSecret(project.name, 'jira-token'), describeSecretError)
  if (token === null) {
    fail(
      `No JIRA token found for project "${project.name}". Run \`ticketsmith project add tickets\` to store one.`,
    )
  }
  return {
    ...services.connectTickets(config, token.value),
    config,
    tokenSource: token.source,
  }
}

export const NO_DATABASES =
  'This project has no databases. Add them with `ticketsmith project add databases`.'

/** The project's databases (connected lazily), or an explanation of how to add them. */
export const requireDatabases = (
  services: Services,
  { project }: OpenedProject,
): DatabaseConnections => {
  if (project.integrations.databases === undefined) fail(NO_DATABASES)
  return new DatabaseConnections(services, project)
}
