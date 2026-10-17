import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describeAgentError } from '../../core/agent/index.ts'
import { loadTicketTypes, TICKET_TYPES_FILE } from '../../core/classification/index.ts'
import { describeDatabaseError } from '../../core/database/index.ts'
import {
  configuredIntegrations,
  describeProjectError,
  type Project,
  type RepositoryConfig,
  type TicketSourceConfig,
} from '../../core/project/index.ts'
import {
  branchFor,
  hostTypeOf,
  isCloned,
  parseRemote,
  projectRepositories,
  type Repository,
  remoteBranches,
  resolveCommit,
} from '../../core/repos/index.ts'
import { describeSecretError, gitHostSecret } from '../../core/secrets/index.ts'
import { DatabaseConnections, type Services } from '../../core/services/index.ts'
import { describeTicketSourceError, type TicketSourceError } from '../../core/tickets/index.ts'
import { checkNodeRuntime, fnmNodeVersions } from './node-runtime.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
export type Check = { readonly name: string; readonly status: CheckStatus; readonly detail: string }

type AddCheck = (name: string, status: CheckStatus, detail: string) => void

const isPermissionError = (error: TicketSourceError): boolean =>
  error.kind === 'unauthorized' || error.kind === 'forbidden'

/**
 * Checks the project and every configured integration. Never throws, so the report shows all
 * problems at once; integrations that are not configured are reported as skipped.
 */
export const runChecks = async (
  services: Services,
  explicitProject: string | undefined,
): Promise<readonly Check[]> => {
  const checks: Check[] = []
  const add: AddCheck = (name, status, detail) => checks.push({ name, status, detail })

  const name = await services.projects.resolveProjectName(explicitProject)
  if (!name.ok) {
    add('project', 'fail', describeProjectError(name.error))
    return checks
  }
  const project = await services.projects.load(name.value)
  if (!project.ok) {
    add('project', 'fail', describeProjectError(project.error))
    return checks
  }
  const integrations = configuredIntegrations(project.value)
  add(
    'project',
    'ok',
    `"${name.value}" with ${integrations.length > 0 ? integrations.join(', ') : 'no integrations yet'}`,
  )

  const tickets = project.value.integrations.tickets
  if (tickets === undefined) {
    add('tickets', 'skip', 'Not configured (`ticketsmith project add tickets`)')
  } else {
    await checkTickets(services, project.value, tickets, add)
  }
  if (project.value.integrations.databases === undefined) {
    add('databases', 'skip', 'Not configured (`ticketsmith project add databases`)')
  } else {
    await checkDatabases(services, project.value, add)
  }
  if (tickets !== undefined || project.value.integrations.repos !== undefined) {
    await checkAgent(services, add)
  }
  if (tickets !== undefined) await checkEvals(services, name.value, add)
  if (project.value.integrations.repos === undefined) {
    add('repos', 'skip', 'Not configured (`ticketsmith project add repos`)')
  } else {
    const paths = await services.projects.locate(name.value)
    if (!paths.ok) add('repos', 'fail', describeProjectError(paths.error))
    else
      await checkRepos(
        services,
        project.value,
        projectRepositories(project.value, paths.value),
        add,
      )
  }
  return checks
}

const checkTickets = async (
  services: Services,
  project: Project,
  tickets: TicketSourceConfig,
  add: AddCheck,
): Promise<void> => {
  if (tickets.auth === 'scoped') {
    add('token type', 'ok', 'Scoped token through the api.atlassian.com gateway')
  } else {
    add(
      'token type',
      'warn',
      'Classic token: it inherits all your permissions. Prefer a scoped read-only token.',
    )
  }

  const token = await services.loadSecret(project.name, 'jira-token')
  if (!token.ok) {
    add('token', 'fail', describeSecretError(token.error))
    return
  }
  if (token.value === null) {
    add('token', 'fail', 'No token found. Run `ticketsmith project add tickets`.')
    return
  }
  add('token', 'ok', `Found in the ${token.value.source}`)

  const { source, discovery, writer } = services.connectTickets(tickets, token.value.value)
  const identity = await source.verifyConnection()
  if (!identity.ok) {
    add('connection', 'fail', describeTicketSourceError(identity.error))
    return
  }
  add('connection', 'ok', `Authenticated as ${identity.value.displayName}`)
  if (writer === null) {
    add('writes', 'ok', 'Read-only: comments and transitions are off (allowWrites)')
  } else {
    const allowed = await writer.permissions()
    if (!allowed.ok)
      add(
        'writes',
        'warn',
        `Could not check write permissions: ${describeTicketSourceError(allowed.error)}`,
      )
    else if (allowed.value.addComments && allowed.value.transitionIssues) {
      add('writes', 'ok', 'You can post comments and transitions, each confirmed in the terminal')
    } else {
      const missing = [
        allowed.value.addComments ? '' : 'add comments',
        allowed.value.transitionIssues ? '' : 'transition issues',
      ].filter(Boolean)
      add(
        'writes',
        'warn',
        `allowWrites is on, but the account cannot ${missing.join(' or ')} (check the token's write:jira-work scope and project permissions)`,
      )
    }
  }

  if (tickets.jql === undefined) {
    add('jql', 'warn', 'No JQL configured. Run `ticketsmith jira discover`.')
  } else {
    const search = await source.search({ query: tickets.jql, limit: 1 })
    add(
      'jql',
      search.ok ? 'ok' : 'fail',
      search.ok
        ? search.value.tickets.length > 0
          ? "The project's JQL returns tickets"
          : "The project's JQL works but returns no tickets right now"
        : describeTicketSourceError(search.error),
    )
  }

  if (tickets.boardId !== undefined && discovery !== null) {
    const board = await discovery.getBoard(tickets.boardId)
    if (board.ok) {
      add('board', 'ok', `Board #${board.value.id} "${board.value.name}" is readable`)
    } else {
      add(
        'board',
        'warn',
        isPermissionError(board.error)
          ? 'Board API not allowed for this token (needs read:board-scope:jira-software, read:project:jira). `list` and `show` still work.'
          : describeTicketSourceError(board.error),
      )
    }
  }
}

/** One check per database: reachable with its stored password, and whether the account can write. */
const checkDatabases = async (
  services: Services,
  project: Project,
  add: AddCheck,
): Promise<void> => {
  const connections = new DatabaseConnections(services, project)
  try {
    for (const config of connections.configs) {
      const name = `db ${config.name}`
      const adapter = await connections.connect(config.name)
      if (!adapter.ok) {
        add(name, 'fail', adapter.error)
        continue
      }
      const ping = await adapter.value.ping()
      if (!ping.ok) {
        add(name, 'fail', describeDatabaseError(ping.error))
        continue
      }
      const canWrite = await adapter.value.accountCanWrite()
      const changes = config.allowChanges
        ? ' The agent may propose changes here; each one needs your approval (`ticketsmith changes approve`).'
        : ''
      if (canWrite.ok && canWrite.value) {
        add(
          name,
          'warn',
          `Reachable; the account can write (Ticketsmith only runs guarded reads in READ ONLY transactions, and writes only approved changes).${changes}`,
        )
      } else {
        add(name, 'ok', `Reachable with a read-only account.${changes}`)
      }
    }
  } finally {
    await connections[Symbol.asyncDispose]()
  }
}

/** Remote access with the user's git credentials, base branches, the clone and the runtime. */
const checkRepos = async (
  services: Services,
  project: Project,
  repositories: readonly Repository[],
  add: AddCheck,
): Promise<void> => {
  let installed: readonly string[] | null | undefined
  for (const { config, dir } of repositories) {
    const name = `repo ${config.name}`
    const branches = await remoteBranches(config.url)
    if (!branches.ok) {
      add(name, 'fail', `Cannot reach ${config.url}: ${branches.error}`)
    } else {
      const missing = [config.branches.fix, config.branches.feature].filter(
        (branch) => !branches.value.includes(branch),
      )
      if (missing.length > 0) {
        add(
          name,
          'fail',
          `Base branch(es) missing on the remote: ${[...new Set(missing)].join(', ')}`,
        )
      } else if (!isCloned(dir)) {
        add(name, 'warn', 'Reachable, but not cloned yet: run `ticketsmith project refresh repos`')
      } else {
        const head = await resolveCommit(dir, 'HEAD')
        add(
          name,
          'ok',
          head.ok
            ? `Reachable; clone at ${config.branches.fix} ${head.value.id.slice(0, 7)} (${head.value.date.slice(0, 10)})`
            : `Reachable; clone unreadable: ${head.error}`,
        )
      }
    }
    if (config.allowCodeChanges) await checkCodeChanges(services, project, config, add)
    if (config.runtime.node !== undefined) {
      installed ??= await fnmNodeVersions()
      const runtime = checkNodeRuntime(config.runtime.node, installed)
      add(`${name} runtime`, runtime.status, runtime.detail)
    }
  }
}

/** Claude Code runs `process` and deep repository analyses. */
const checkAgent = async (services: Services, add: AddCheck): Promise<void> => {
  const status = await services.agent.check()
  if (!status.ok) {
    add('agent', 'fail', describeAgentError(status.error))
  } else if (!status.value.loggedIn) {
    add(
      'agent',
      'fail',
      `Claude Code ${status.value.version} is not signed in: run \`claude\` and log in`,
    )
  } else {
    add(
      'agent',
      'ok',
      `Claude Code ${status.value.version}, signed in${status.value.authMethod === undefined ? '' : ` (${status.value.authMethod})`}`,
    )
  }
}

/** Repositories where the agent may change code: a valid branch pattern and, for PRs, a host token. */
const checkCodeChanges = async (
  services: Services,
  project: Project,
  config: RepositoryConfig,
  add: AddCheck,
): Promise<void> => {
  const name = `repo ${config.name} code`
  const branch = branchFor(config.branchPattern, 'OPS-1', 'example')
  if (!branch.ok) {
    add(name, 'fail', branch.error)
    return
  }
  const type = hostTypeOf(config)
  const remote = parseRemote(config.url)
  if (type === 'none' || remote === null) {
    add(
      name,
      'ok',
      `Code changes on; branches like ${branch.value}. Pull requests: link only (no provider for this host)`,
    )
    return
  }
  const token = await services.loadSecret(project.name, gitHostSecret(remote.hostname))
  add(
    name,
    token.ok && token.value !== null ? 'ok' : 'warn',
    token.ok && token.value !== null
      ? `Code changes on; branches like ${branch.value}; ${type} pull requests through the API`
      : `Code changes on; branches like ${branch.value}. No ${type} token yet: \`ticketsmith code push\` asks for one, or you get a link`,
  )
}

/** Requirements §4.13: no autonomy for a type without evals; two per type is the minimum. */
const checkEvals = async (
  services: Services,
  projectName: string,
  add: AddCheck,
): Promise<void> => {
  const paths = await services.projects.locate(projectName)
  if (!paths.ok) return
  const types = await loadTicketTypes(paths.value.knowledgeDir)
  if (!types.ok) {
    add('ticket types', 'fail', types.error)
    return
  }
  if (types.value === null) {
    add(
      'ticket types',
      'warn',
      `No knowledge/${TICKET_TYPES_FILE}: run \`ticketsmith project refresh tickets\` to draft it`,
    )
    return
  }
  const counts = new Map<string, number>()
  const files = await readdir(paths.value.evalsDir).catch(() => [] as string[])
  for (const file of files.filter((f) => f.endsWith('.yaml'))) {
    const match = /^expectedType:\s*(\S+)/m.exec(
      await readFile(join(paths.value.evalsDir, file), 'utf8'),
    )
    if (match?.[1] !== undefined) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  const thin = types.value.types
    .filter((type) => (counts.get(type.name) ?? 0) < 2)
    .map((type) => `${type.name} (${counts.get(type.name) ?? 0})`)
  add(
    'evals',
    thin.length === 0 ? 'ok' : 'warn',
    thin.length === 0
      ? `${files.length} eval(s), at least 2 per type`
      : `Fewer than 2 evals for: ${thin.join(', ')}. Add resolved tickets with \`ticketsmith eval add <KEY>\``,
  )
}
