import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const REGISTRY_URL = 'https://registry.npmjs.org/ticketsmith/latest'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 1500

const CacheSchema = z.object({ checkedAt: z.number(), latest: z.string() })
const LatestSchema = z.object({ version: z.string() })

export type UpdateCheck = {
  readonly current: string
  /** JSON file holding the last check, e.g. `~/.cache/ticketsmith/update-check.json`. */
  readonly cacheFile: string
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly now: number
}

/** Compares `x.y.z` versions; anything that is not plain numbers never counts as newer. */
export const isNewer = (candidate: string, current: string): boolean => {
  const parse = (version: string) =>
    /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null
  const a = parse(candidate)
  const b = parse(current)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

const readCache = async (file: string) => {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const fetchLatest = async (fetch: UpdateCheck['fetch']): Promise<string | null> => {
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return null
    const parsed = LatestSchema.safeParse(await response.json())
    return parsed.success ? parsed.data.version : null
  } catch {
    return null
  }
}

/**
 * Returns a one-line notice when npm has a newer release, asking the registry at most once a day.
 * Never fails: no network, a bad cache or a registry error simply mean no notice.
 */
export const checkForUpdate = async ({
  current,
  cacheFile,
  fetch,
  now,
}: UpdateCheck): Promise<string | null> => {
  let cache = await readCache(cacheFile)
  if (cache === null || now - cache.checkedAt >= CHECK_EVERY_MS) {
    const latest = await fetchLatest(fetch)
    cache = { checkedAt: now, latest: latest ?? cache?.latest ?? current }
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(cacheFile, JSON.stringify(cache))
    } catch {
      // An unwritable cache only means asking again next time.
    }
  }
  return isNewer(cache.latest, current)
    ? `ticketsmith ${cache.latest} is available (you have ${current}): npm i -g ticketsmith`
    : null
}
