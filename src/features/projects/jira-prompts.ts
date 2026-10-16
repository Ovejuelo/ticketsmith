import { z } from 'zod'
import { askChoice, askSecret, askText, note, orFail } from '../../core/cli/index.ts'
import {
  type JiraAuthKind,
  type JiraCloudSourceConfig,
  normalizeSiteUrl,
} from '../../core/project/index.ts'
import type { JiraConnectionInput } from './connect-ticket-source.ts'

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

const validateSite = (value: string): string | undefined => {
  const result = normalizeSiteUrl(value)
  return result.ok ? undefined : result.error
}

/** Interactive questions for a JIRA Cloud connection; defaults come from the current config. */
export const askJiraConnection = async (
  current: JiraCloudSourceConfig | undefined,
): Promise<JiraConnectionInput> => {
  const siteInput = await askText({
    message: 'JIRA site',
    placeholder: 'acme.atlassian.net',
    initialValue: current?.siteUrl ?? '',
    validate: validateSite,
  })
  const email = await askText({
    message: 'Atlassian account email',
    initialValue: current?.email ?? '',
    validate: validateWith(z.email()),
  })
  const auth = await askChoice<JiraAuthKind>(
    'Token type',
    [
      { value: 'scoped', label: 'API token with scopes', hint: 'recommended, read-only' },
      { value: 'classic', label: 'Classic API token', hint: 'inherits all your permissions' },
    ],
    current?.auth ?? 'scoped',
  )
  note(TOKEN_HELP, 'API token')
  const token = await askSecret('API token (stored in the system keychain)')
  return { siteUrl: orFail(normalizeSiteUrl(siteInput), String), email, auth, token }
}
