import type { JiraProjectOverview } from '#src/core/tickets/index.ts'

export const sampleOverview: JiraProjectOverview = {
  key: 'OPS',
  name: 'Support L2',
  description: '',
  issueTypes: [
    {
      name: 'Incident',
      description: '',
      subtask: false,
      statuses: [{ name: 'Done', category: 'Done' }],
    },
  ],
  components: [],
}
