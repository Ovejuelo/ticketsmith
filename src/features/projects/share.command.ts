import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Command } from 'commander'
import { parse } from 'yaml'
import { type CommandDeps, fail, globalOptions, openProject, orFail } from '../../core/cli/index.ts'
import { describeProjectError, ProjectSchema } from '../../core/project/index.ts'
import { copySharedFiles, exportProject } from './share-project.ts'

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(path))

const NEXT_STEPS =
  'Add your own credentials with `ticketsmith project add tickets`, then `ticketsmith project refresh`.'

export const linkCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('link')
    .description('Register a project folder that lives elsewhere (e.g. a clone of its git repo)')
    .argument('<path>', 'folder containing project.yaml')
    .action(async (path: string, _, command: Command) => {
      const services = servicesFor(command)
      const project = orFail(await services.projects.link(absolute(path)), describeProjectError)
      io.out(`Linked project "${project.name}" at ${absolute(path)}.\n${NEXT_STEPS}\n`)
    })

export const exportCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('export')
    .description('Copy the shareable part of a project (project.yaml + knowledge/) to a folder')
    .argument('<dir>', 'destination folder (new or empty)')
    .action(async (dir: string, _, command: Command) => {
      const services = servicesFor(command)
      const { project, paths } = await openProject(services, globalOptions(command).project)
      const copied = orFail(await exportProject(paths, absolute(dir)), String)
      io.out(
        `Exported "${project.name}" (${copied.join(', ')}) to ${absolute(dir)}. No secrets or local state included.\n`,
      )
    })

export const importCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('import')
    .description('Copy an exported project into your projects folder')
    .argument('<dir>', 'folder created by `project export` (or a clone of the project repo)')
    .action(async (dir: string, _, command: Command) => {
      const services = servicesFor(command)
      const source = absolute(dir)
      let raw: unknown
      try {
        raw = parse(await readFile(join(source, 'project.yaml'), 'utf8'))
      } catch {
        fail(`${source} has no readable project.yaml.`)
      }
      const parsed = ProjectSchema.safeParse(raw)
      if (!parsed.success) fail(`${source}/project.yaml is not a valid project.`)
      const name = parsed.data.name
      if (await services.projects.exists(name)) {
        fail(
          `Project "${name}" already exists. To use a clone in place, run \`ticketsmith project link ${dir}\`.`,
        )
      }
      const target = orFail(await services.projects.locate(name), describeProjectError)
      orFail(await copySharedFiles(source, target.root), String)
      io.out(`Imported project "${name}" into ${target.root}.\n${NEXT_STEPS}\n`)
    })
