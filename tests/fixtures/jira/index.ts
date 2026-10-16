import { readFileSync } from 'node:fs'

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'))

/** Synthetic fixtures shaped like real JIRA Cloud v3 responses. Replace with anonymized real ones. */
export const jiraFixtures = {
  issue: () => load('issue'),
  comments: () => load('comments'),
  searchJql: () => load('search-jql'),
}
