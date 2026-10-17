import { readFileSync } from 'node:fs'

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'))

/** Synthetic fixtures shaped like real JIRA Data Center REST API v2 responses (wiki markup). */
export const jiraDataCenterFixtures = {
  issue: () => load('issue'),
  search: () => load('search'),
}
