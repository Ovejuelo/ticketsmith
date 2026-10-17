import { err, ok, type Result } from '../kernel/index.ts'

/** Accepts `acme.atlassian.net`, a full URL or a deep link and returns the https origin. */
/**
 * An https site URL without a trailing slash. Cloud sites are origins; `keepPath` keeps a context
 * path, which JIRA Data Center servers often have (https://acme.com/jira).
 */
export const normalizeSiteUrl = (
  input: string,
  options: { readonly keepPath?: boolean } = {},
): Result<string, string> => {
  const trimmed = input.trim()
  if (trimmed === '') return err('Site URL is required')
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:') return err('Site URL must use https')
    return ok(options.keepPath ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : url.origin)
  } catch {
    return err(`Not a valid URL: ${trimmed}`)
  }
}
