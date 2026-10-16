import { describe, expect, it } from 'vitest'
import { normalizeSiteUrl } from '#src/core/project/site-url.ts'

describe('normalizeSiteUrl', () => {
  it.each([
    ['acme.atlassian.net', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/', 'https://acme.atlassian.net'],
    [
      'https://acme.atlassian.net/jira/software/c/projects/OPS/boards/245',
      'https://acme.atlassian.net',
    ],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSiteUrl(input)).toEqual({ ok: true, value: expected })
  })

  it.each(['', 'http://acme.atlassian.net', 'https://'])('rejects %j', (input) => {
    expect(normalizeSiteUrl(input).ok).toBe(false)
  })
})
