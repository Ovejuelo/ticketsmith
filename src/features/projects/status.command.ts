import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { type CommandDeps, globalOptions, orFail } from '../../core/cli/index.ts'
import { describeProjectError, INTEGRATIONS, type Integration } from '../../core/project/index.ts'
import {
  describeStorageError,
  type OnboardingStep,
  withProjectDatabase,
} from '../../core/storage/index.ts'
import { isGitRepository } from './git-repository.ts'

type IntegrationStatus = {
  readonly integration: Integration
  readonly configured: boolean
  readonly investigation: OnboardingStep | null
}

const listMarkdown = async (dir: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort()
  } catch {
    return []
  }
}

// Stored in UTC; shown in the user's local time.
const localTime = (iso: string): string => {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const describeIntegration = ({ configured, investigation }: IntegrationStatus): string => {
  if (!configured) return pc.dim('not configured')
  if (investigation === null) return pc.yellow('configured, not investigated yet')
  const when = localTime(investigation.updatedAt)
  return investigation.status === 'done'
    ? `${pc.green('investigated')} ${when} · ${investigation.detail ?? ''}`
    : `${pc.red(investigation.status)} ${when} · ${investigation.detail ?? ''}`
}

export const statusCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('status')
    .description('What is configured, investigated or pending in a project')
    .argument('[name]', 'project name (defaults to the active one)')
    .action(async (name: string | undefined, _, command: Command) => {
      const services = servicesFor(command)
      const global = globalOptions(command)
      const resolved = orFail(
        await services.projects.resolveProjectName(name ?? global.project),
        describeProjectError,
      )
      const project = orFail(await services.projects.load(resolved), describeProjectError)
      const paths = orFail(await services.projects.locate(resolved), describeProjectError)
      const active = await services.projects.resolveProjectName(undefined)

      const steps = orFail(
        await withProjectDatabase(paths.sqlite, (db) => db.steps()),
        describeStorageError,
      )
      const integrations: IntegrationStatus[] = INTEGRATIONS.map((integration) => ({
        integration,
        configured: project.integrations[integration] !== undefined,
        investigation: steps.find((step) => step.step === integration) ?? null,
      }))
      const knowledge = await listMarkdown(paths.knowledgeDir)
      const git = isGitRepository(paths.root)

      if (global.json) {
        io.out(
          `${JSON.stringify(
            {
              name: project.name,
              active: active.ok && active.value === project.name,
              folder: paths.root,
              git,
              integrations,
              knowledge,
            },
            null,
            2,
          )}\n`,
        )
        return
      }
      io.out(
        [
          `${pc.bold('Project')}   ${project.name}${active.ok && active.value === project.name ? ' (active)' : ''}`,
          `${pc.bold('Folder')}    ${paths.root}${git ? '  (git repository)' : ''}`,
          '',
          pc.bold('Integrations'),
          ...integrations.map((s) => `  ${s.integration.padEnd(12)} ${describeIntegration(s)}`),
          '',
          pc.bold('Knowledge'),
          ...(knowledge.length > 0 ? knowledge.map((file) => `  ${file}`) : ['  (none yet)']),
          '',
        ].join('\n'),
      )
    })
