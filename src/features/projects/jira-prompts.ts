import { z } from 'zod'
import { askChoice, askSecret, askText, note, orFail } from '../../core/cli/index.ts'
import {
  type JiraAuthKind,
  normalizeSiteUrl,
  type TicketSourceConfig,
} from '../../core/project/index.ts'
import type { JiraConnectionInput, JiraDeployment } from './connect-ticket-source.ts'

const TOKEN_HELP = [
  'Create a token at https://id.atlassian.com/manage-profile/security/api-tokens',
  'Prefer "Create API token with scopes" and grant read-only scopes:',
  '  read:jira-work, read:jira-user',
  '  read:board-scope:jira-software, read:project:jira (optional, for boards)',
].join('\n')

export const validateWith =
  (schema: z.ZodType) =>
  (value: string): string | undefined => {
    const result = schema.safeParse(value.trim())
    return result.success ? undefined : (result.error.issues[0]?.message ?? 'Invalid value')
  }

const PAT_HELP = [
  'Create a personal access token in JIRA: your avatar → Profile → Personal Access Tokens.',
  'It acts with your permissions; a read-only account is safest.',
].join('\n')

const validateSite = (value: string): string | undefined => {
  const result = normalizeSiteUrl(value, { keepPath: true })
  return result.ok ? undefined : result.error
}

/** Interactive questions for a JIRA connection; defaults come from the current config. */
export const askJiraConnection = async (
  current: TicketSourceConfig | undefined,
): Promise<JiraConnectionInput> => {
  const deployment = await askChoice<JiraDeployment>(
    'Which JIRA?',
    [
      { value: 'cloud', label: 'JIRA Cloud', hint: '*.atlassian.net' },
      { value: 'data-center', label: 'JIRA Data Center / Server', hint: 'self-hosted' },
    ],
    current?.type === 'jira-data-center' ? 'data-center' : 'cloud',
  )
  if (deployment === 'data-center') {
    const site = await askText({
      message: 'JIRA base URL',
      placeholder: 'https://jira.acme.com',
      initialValue: current?.type === 'jira-data-center' ? current.siteUrl : '',
      validate: validateSite,
    })
    note(PAT_HELP, 'Personal access token')
    const token = await askSecret('Personal access token (stored in the system keychain)')
    return {
      deployment,
      siteUrl: orFail(normalizeSiteUrl(site, { keepPath: true }), String),
      token,
    }
  }
  const cloud = current?.type === 'jira-cloud' ? current : undefined
  const siteInput = await askText({
    message: 'JIRA site',
    placeholder: 'acme.atlassian.net',
    initialValue: cloud?.siteUrl ?? '',
    validate: (value) => {
      const result = normalizeSiteUrl(value)
      return result.ok ? undefined : result.error
    },
  })
  const email = await askText({
    message: 'Atlassian account email',
    initialValue: cloud?.email ?? '',
    validate: validateWith(z.email()),
  })
  const auth = await askChoice<JiraAuthKind>(
    'Token type',
    [
      { value: 'scoped', label: 'API token with scopes', hint: 'recommended, read-only' },
      { value: 'classic', label: 'Classic API token', hint: 'inherits all your permissions' },
    ],
    cloud?.auth ?? 'scoped',
  )
  note(TOKEN_HELP, 'API token')
  const token = await askSecret('API token (stored in the system keychain)')
  return { siteUrl: orFail(normalizeSiteUrl(siteInput), String), email, auth, token }
}
