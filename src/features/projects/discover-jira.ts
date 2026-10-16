import {
  askChoice,
  askChoices,
  askText,
  fail,
  type Io,
  log,
  openProject,
  orFail,
  requireTickets,
} from '../../core/cli/index.ts'
import { describeProjectError } from '../../core/project/index.ts'
import type { Services } from '../../core/services/index.ts'
import {
  defaultProjectJql,
  deriveOpenTicketsJql,
  describeTicketSourceError,
  type JiraDiscovery,
  type TicketSourceError,
} from '../../core/tickets/index.ts'

export type DiscoverOptions = {
  readonly project: string | undefined
  readonly board?: number | undefined
  /** JIRA project key, when not using a board. */
  readonly key?: string | undefined
  readonly fields: boolean
}

const NO_BOARD = -1

const isPermissionError = (error: TicketSourceError): boolean =>
  error.kind === 'unauthorized' || error.kind === 'forbidden'

const AGILE_SCOPE_HINT =
  'The token probably lacks Jira Software scopes (read:board-scope:jira-software, read:project:jira).'

/**
 * Chooses the JIRA project, board and JQL and saves them in the Ticketsmith project. Board access is optional: when
 * the agile API is not allowed for the token, it falls back to a project JQL.
 */
export const runDiscover = async (
  services: Services,
  io: Io,
  options: DiscoverOptions,
): Promise<void> => {
  const opened = await openProject(services, options.project)
  const { project } = opened
  const connection = await requireTickets(services, opened)
  const discovery =
    connection.discovery ?? fail(`The ticket source of "${project.name}" has no discovery support.`)
  const tickets = connection.config
  const warn = (message: string) => (io.interactive ? log.warn(message) : io.err(`! ${message}\n`))

  let projectKey = options.key?.toUpperCase() ?? tickets.projectKey
  let boardId = options.board

  if (boardId === undefined && options.key === undefined && io.interactive) {
    projectKey = await pickProject(discovery, projectKey)
    const boards = await discovery.listBoards(projectKey)
    if (boards.ok && boards.value.length > 0) {
      const picked = await askChoice(
        'Board',
        [
          ...boards.value.map((board) => ({
            value: board.id,
            label: `${board.name} (#${board.id})`,
            hint: board.type,
          })),
          { value: NO_BOARD, label: 'No board', hint: 'use all open tickets of the project' },
        ],
        tickets.boardId,
      )
      boardId = picked === NO_BOARD ? undefined : picked
    } else if (!boards.ok) {
      warn(`Cannot list boards: ${describeTicketSourceError(boards.error)} ${AGILE_SCOPE_HINT}`)
    }
  }

  let jql: string | undefined
  if (boardId !== undefined) {
    const board = await discovery.getBoard(boardId)
    if (board.ok) {
      projectKey = board.value.projectKey ?? projectKey
      const filterJql = await discovery.getBoardFilterJql(boardId)
      if (filterJql.ok) {
        jql = deriveOpenTicketsJql(filterJql.value)
      } else {
        warn(
          `Cannot read the filter of board ${boardId}: ${describeTicketSourceError(filterJql.error)}`,
        )
      }
    } else if (isPermissionError(board.error)) {
      warn(`Cannot read board ${boardId}. ${AGILE_SCOPE_HINT} Falling back to a project JQL.`)
    } else {
      fail(describeTicketSourceError(board.error))
    }
  }

  if (jql === undefined) {
    if (projectKey === undefined) {
      if (!io.interactive) fail('Pass --key <JIRA project key> (or a readable --board <id>).')
      projectKey = await pickProject(discovery, undefined)
    }
    jql = defaultProjectJql(projectKey)
  }

  if (io.interactive) {
    jql = await askText({
      message: 'JQL used by `ticketsmith list` (edit if needed)',
      initialValue: jql,
      validate: (value) => (value.trim() === '' ? 'Required' : undefined),
    })
  }

  const customFields = options.fields
    ? await pickCustomFields(discovery, tickets.customFields, io)
    : tickets.customFields

  orFail(
    await services.projects.save({
      ...project,
      integrations: {
        ...project.integrations,
        tickets: { ...tickets, projectKey, boardId, jql, customFields },
      },
    }),
    describeProjectError,
  )
  io.out(
    [
      `Saved to project "${project.name}":`,
      `  JIRA project: ${projectKey ?? '-'}`,
      `  board:        ${boardId ?? '-'}`,
      `  jql:          ${jql}`,
      ...Object.entries(customFields).map(([alias, id]) => `  field:        ${alias} = ${id}`),
      '',
    ].join('\n'),
  )
}

const pickProject = async (
  discovery: JiraDiscovery,
  current: string | undefined,
): Promise<string> => {
  const projects = orFail(await discovery.listProjects(), describeTicketSourceError)
  if (projects.length === 0) fail('This account cannot see any JIRA project.')
  return askChoice(
    'JIRA project (type to filter)',
    projects.map((project) => ({ value: project.key, label: `${project.key} · ${project.name}` })),
    current,
  )
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

const pickCustomFields = async (
  discovery: JiraDiscovery,
  current: Readonly<Record<string, string>>,
  io: Io,
): Promise<Record<string, string>> => {
  if (!io.interactive) fail('--fields needs an interactive terminal.')
  const fields = orFail(await discovery.listCustomFields(), describeTicketSourceError)
  const selected = await askChoices(
    'Custom fields to include in tickets (type to filter, space to select)',
    fields.map((field) => ({ value: field.id, label: field.name, hint: field.id })),
    Object.values(current),
  )
  const aliasById = new Map(Object.entries(current).map(([alias, id]) => [id, alias]))
  const result: Record<string, string> = {}
  for (const id of selected) {
    const name = fields.find((field) => field.id === id)?.name ?? id
    const alias = await askText({
      message: `Alias for "${name}"`,
      initialValue: aliasById.get(id) ?? slug(name),
      validate: (value) => (/^[a-z][a-z0-9_]*$/.test(value) ? undefined : 'Use snake_case'),
    })
    result[alias] = id
  }
  return result
}
