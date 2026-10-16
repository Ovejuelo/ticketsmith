import { execFile } from 'node:child_process'

/** Node versions installed with fnm (`v20.11.1` …), or null when fnm is not available. */
export const fnmNodeVersions = (): Promise<readonly string[] | null> =>
  new Promise((resolve) => {
    execFile('fnm', ['list'], { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) return resolve(null)
      resolve([...stdout.matchAll(/v(\d+\.\d+\.\d+)/g)].map((match) => match[1] ?? ''))
    })
  })

export type RuntimeCheck = { readonly status: 'ok' | 'warn' | 'skip'; readonly detail: string }

/** Whether a repository's Node version (`20`, `20.11`, `20.11.1`) is installed. */
export const checkNodeRuntime = (
  wanted: string,
  installed: readonly string[] | null,
): RuntimeCheck => {
  if (installed === null)
    return { status: 'skip', detail: `Node ${wanted} (fnm not found, not checked)` }
  if (!/^\d+(\.\d+){0,2}$/.test(wanted)) {
    return { status: 'skip', detail: `Node ${wanted} (a range, not checked)` }
  }
  const match = installed.find((version) => version === wanted || version.startsWith(`${wanted}.`))
  return match === undefined
    ? { status: 'warn', detail: `Node ${wanted} is not installed: \`fnm install ${wanted}\`` }
    : { status: 'ok', detail: `Node ${wanted} installed (${match})` }
}
