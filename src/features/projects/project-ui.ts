import { type Io, log, type OpenedProject, orFail } from '../../core/cli/index.ts'
import { describeProjectError, type Project } from '../../core/project/index.ts'
import type { Services } from '../../core/services/index.ts'
import { emptyProject } from './connect-ticket-source.ts'
import type { StepReport } from './onboarding.ts'

export const loadOrCreate = async (services: Services, name: string): Promise<Project> =>
  (await services.projects.exists(name))
    ? orFail(await services.projects.load(name), describeProjectError)
    : emptyProject(name)

export const openByName = async (services: Services, name: string): Promise<OpenedProject> => ({
  project: orFail(await services.projects.load(name), describeProjectError),
  paths: orFail(await services.projects.locate(name), describeProjectError),
})

export const printReports = (io: Io, reports: readonly StepReport[]): void => {
  for (const report of reports) {
    const line = `${report.step}: ${report.detail}`
    if (!io.interactive) io.err(`${report.status === 'done' ? '✔' : '!'} ${line}\n`)
    else if (report.status === 'done') log.success(line)
    else log.warn(line)
  }
}
