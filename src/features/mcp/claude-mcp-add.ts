import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Runtime } from '../../core/cli/index.ts'

/** Real paths, because version managers like fnm expose node through per-shell temporary links. */
const stablePath = (path: string): string => {
  const absolute = isAbsolute(path) ? path : resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

export const mcpAddCommand = (runtime: Runtime, project: string | undefined): string =>
  [
    'claude mcp add --scope user ticketsmith --',
    stablePath(runtime.execPath),
    stablePath(runtime.scriptPath),
    ...(project === undefined ? [] : ['--project', project]),
    'mcp',
  ]
    .map((part, index) => (index === 0 ? part : quote(part)))
    .join(' ')
