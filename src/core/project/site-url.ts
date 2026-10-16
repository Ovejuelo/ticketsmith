import { err, ok, type Result } from '../kernel/index.ts'

/** Accepts `acme.atlassian.net`, a full URL or a deep link and returns the https origin. */
export const normalizeSiteUrl = (input: string): Result<string, string> => {
  const trimmed = input.trim()
  if (trimmed === '') return err('Site URL is required')
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:') return err('Site URL must use https')
    return ok(url.origin)
  } catch {
    return err(`Not a valid URL: ${trimmed}`)
  }
}
