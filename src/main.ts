#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import pc from 'picocolors'
import pkg from '../package.json' with { type: 'json' }
import { buildProgram } from './bootstrap/cli.ts'
import { createServices } from './bootstrap/composition-root.ts'
import { CliError, checkForUpdate, type Io } from './core/cli/index.ts'
import { AppError, createLogger } from './core/kernel/index.ts'

// `ticketsmith show X | head` closes stdout early; that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const io: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  columns: process.stdout.columns ?? 120,
}

const program = buildProgram(pkg.version, {
  io,
  runtime: { execPath: process.execPath, scriptPath: process.argv[1] ?? '' },
  services: (options) =>
    createServices({
      env: process.env,
      home: homedir(),
      logger: createLogger({ level: options.verbose ? 'debug' : 'warn' }),
    }),
})

// Asked in parallel with the command and shown after it, on stderr. Never for `mcp` (a long-lived
// server whose stdout belongs to the protocol), machine-readable output, CI or non-terminals.
const args = process.argv.slice(2)
const wantsUpdateCheck =
  process.stderr.isTTY &&
  args[0] !== 'mcp' &&
  !args.includes('--json') &&
  process.env['CI'] === undefined &&
  process.env['TICKETSMITH_NO_UPDATE_CHECK'] === undefined
const updateNotice = wantsUpdateCheck
  ? checkForUpdate({
      current: pkg.version,
      cacheFile: join(
        process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
        'ticketsmith',
        'update-check.json',
      ),
      fetch: globalThis.fetch,
      now: Date.now(),
    })
  : Promise.resolve(null)

try {
  await program.parseAsync(process.argv)
} catch (error) {
  const message =
    error instanceof CliError
      ? error.message
      : error instanceof AppError
        ? `${error.message} (${error.code})`
        : String(error)
  console.error(pc.red(`✖ ${message}`))
  process.exitCode = 1
}

const notice = await updateNotice
if (notice !== null) console.error(pc.yellow(notice))
