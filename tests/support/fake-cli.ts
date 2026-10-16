import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { buildProgram } from '#src/bootstrap/cli.ts'
import { ok } from '#src/core/kernel/index.ts'
import {
  type DatabaseConfig,
  type JiraCloudSourceConfig,
  type Project,
  ProjectStore,
  type RepositoryConfig,
  resolvePaths,
  type TicketSourceConfig,
} from '#src/core/project/index.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'
import type { Services, TicketsConnection } from '#src/core/services/index.ts'
import { FakeAgentRuntime } from '#tests/support/fake-agent-runtime.ts'
import { FakeDatabases } from '#tests/support/fake-database.ts'
import { FakeJiraDiscovery } from '#tests/support/fake-jira-discovery.ts'
import { FakePullRequestHosts } from '#tests/support/fake-pull-request-host.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'
import { InMemorySecretStore } from '#tests/support/in-memory-secret-store.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'

export const testJira = (
  overrides: Partial<JiraCloudSourceConfig> = {},
): JiraCloudSourceConfig => ({
  type: 'jira-cloud',
  siteUrl: 'https://example.atlassian.net',
  email: 'me@acme.test',
  auth: 'scoped',
  cloudId: 'cloud-1',
  customFields: {},
  ...overrides,
})

export const testDatabase = (
  name: string,
  overrides: Partial<Omit<DatabaseConfig, 'type'>> = {},
): DatabaseConfig => ({
  name,
  type: 'mysql',
  host: `${name}.db.internal`,
  port: 3306,
  database: 'app',
  user: 'reader',
  ssl: false,
  allowChanges: false,
  ...overrides,
})

/** Adds databases (and their passwords, `pw-<name>`) to a project. */
export const withDatabases = (project: Project, databases: readonly DatabaseConfig[]): Project => ({
  ...project,
  integrations: { ...project.integrations, databases: [...databases] },
})

export const testRepository = (
  name: string,
  overrides: Partial<Omit<RepositoryConfig, 'type'>> = {},
): RepositoryConfig => ({
  name,
  type: 'git',
  url: `git@git.acme.dev:acme/${name}.git`,
  branches: { fix: 'main', feature: 'main' },
  protectedBranches: ['main'],
  runtime: {},
  allowCodeChanges: false,
  branchPattern: 'fix/{key}-{slug}',
  ...overrides,
})

export const withRepositories = (
  project: Project,
  repos: readonly RepositoryConfig[],
): Project => ({
  ...project,
  integrations: { ...project.integrations, repos: [...repos] },
})

/** A project named "acme" with a JIRA ticket source (pass `null` for no ticket source). */
export const testProject = (
  tickets: Partial<JiraCloudSourceConfig> | null = {},
  name = 'acme',
): Project => ({
  version: 2,
  name,
  integrations: tickets === null ? {} : { tickets: testJira(tickets) },
  masking: { detectors: [...ALL_MASK_KINDS], custom: [], keepEmailDomains: true },
  agent: { maxBudgetUsd: 3, timeoutMinutes: 20 },
  changes: { maxRows: 100 },
  code: { testTimeoutMinutes: 15 },
})

/** A CLI wired to fakes, a temp home dir and captured output. */
export class FakeCli {
  readonly home: string
  readonly secrets = new InMemorySecretStore('keychain')
  source = new InMemoryTicketSource()
  discovery = new FakeJiraDiscovery()
  readonly connections: { config: TicketSourceConfig; token: string }[] = []
  readonly audit = new InMemoryAuditLog()
  readonly databases = new FakeDatabases()
  readonly agent = new FakeAgentRuntime()
  readonly pullRequests = new FakePullRequestHosts()
  stdout = ''
  stderr = ''
  readonly services: Services

  private constructor(home: string) {
    this.home = home
    const paths = resolvePaths({}, home)
    this.services = {
      paths,
      projects: new ProjectStore(paths),
      loadSecret: async (project, name) => {
        const value = await this.secrets.get({ project, name })
        return value.ok && value.value !== null
          ? ok({ value: value.value, source: this.secrets.source })
          : ok(null)
      },
      saveSecret: (project, name, value) => this.secrets.set({ project, name }, value),
      deleteSecret: (project, name) => this.secrets.delete({ project, name }),
      resolveCloudId: async () => ok('cloud-1'),
      connectTickets: (config, token): TicketsConnection => {
        this.connections.push({ config, token })
        return { source: this.source, discovery: this.discovery }
      },
      connectDatabase: (config, password) => this.databases.connect(config.name, password),
      agent: this.agent,
      pullRequestHost: (type) => this.pullRequests.host(type),
      openAuditLog: () => this.audit,
    }
  }

  static async create(): Promise<FakeCli> {
    return new FakeCli(await mkdtemp(join(tmpdir(), 'ticketsmith-cli-')))
  }

  /** Saves the project, makes it active and stores its JIRA token when it has a ticket source. */
  async withProject(project: Project = testProject(), token = 'secret-token'): Promise<this> {
    await this.services.projects.save(project)
    await this.services.projects.setActiveProject(project.name)
    if (project.integrations.tickets !== undefined) {
      await this.secrets.set({ project: project.name, name: 'jira-token' }, token)
    }
    for (const database of project.integrations.databases ?? []) {
      await this.secrets.set(
        { project: project.name, name: `db-${database.name}` },
        `pw-${database.name}`,
      )
    }
    return this
  }

  /** Runs the CLI; resolves with the error (if any) instead of throwing. */
  async run(...args: string[]): Promise<Error | null> {
    this.stdout = ''
    this.stderr = ''
    const program = buildProgram('1.2.3', {
      io: {
        out: (text) => {
          this.stdout += text
        },
        err: (text) => {
          this.stderr += text
        },
        interactive: false,
        columns: 100,
      },
      runtime: { execPath: '/usr/local/bin/node', scriptPath: '/opt/ticketsmith/dist/main.js' },
      services: () => this.services,
    })
    program.exitOverride().configureOutput({
      writeOut: (text) => {
        this.stdout += text
      },
      writeErr: (text) => {
        this.stderr += text
      },
    })
    // Every level (e.g. `project refresh`) must throw instead of exiting the test process.
    const overrideExit = (command: Command): void => {
      command.exitOverride()
      for (const sub of command.commands) overrideExit(sub)
    }
    overrideExit(program)
    try {
      await program.parseAsync(['node', 'ticketsmith', ...args])
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  cleanup(): Promise<void> {
    return rm(this.home, { recursive: true, force: true })
  }
}
