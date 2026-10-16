import type { Feature } from '../../core/feature/index.ts'
import { jiraCommand } from './jira-discover.command.ts'
import { projectCommand } from './project.command.ts'

/** Create and configure projects and their optional integrations: `project …`, `jira discover`. */
export const projectsFeature: Feature = {
  name: 'projects',
  commands: [projectCommand, jiraCommand],
  tools: [],
}
