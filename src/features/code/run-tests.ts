import { spawn } from 'node:child_process'

export const OUTPUT_LINES = 200

// Credentials that a repository's tests never need; the agent can read their output.
const SECRET_ENV =
  /^(TICKETSMITH_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|GH_TOKEN$|GITHUB_TOKEN$|GITLAB_TOKEN$|BITBUCKET_|NPM_TOKEN$|NODE_AUTH_TOKEN$|ANTHROPIC_|OPENAI_|SSH_AUTH_SOCK$)/

export type TestRun = {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** The last OUTPUT_LINES lines of stdout and stderr, interleaved. */
  readonly output: string
}

/**
 * Runs a repository's configured test command (set by the user in project.yaml, never by the
 * agent) in a worktree: with the repository's Node version through fnm when available, without
 * Ticketsmith's or cloud credentials in the environment, and killed with its children on timeout.
 */
export const runTests = (options: {
  readonly dir: string
  readonly command: string
  readonly node: string | undefined
  readonly timeoutMs: number
}): Promise<TestRun> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !SECRET_ENV.test(name)),
    )
    env['CI'] = '1' // no watch modes or interactive prompts
    const shell = ['sh', '-c', options.command]
    const started = Date.now()
    const start = (useFnm: boolean) => {
      const [command, ...args] =
        useFnm && options.node !== undefined
          ? ['fnm', 'exec', `--using=${options.node}`, '--', ...shell]
          : shell
      const child = spawn(command ?? 'sh', args, {
        cwd: options.dir,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let timedOut = false
      const append = (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 400_000) output = output.slice(-200_000)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      }, options.timeoutMs)
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (useFnm && error.code === 'ENOENT') return start(false) // no fnm: the PATH's Node
        resolve({
          exitCode: null,
          timedOut,
          durationMs: Date.now() - started,
          output: error.message,
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          exitCode: code,
          timedOut,
          durationMs: Date.now() - started,
          output: output.split('\n').slice(-OUTPUT_LINES).join('\n'),
        })
      })
    }
    start(true)
  })

export const describeTestRun = (repo: string, run: TestRun): string => {
  const seconds = Math.round(run.durationMs / 1000)
  const verdict = run.timedOut
    ? `timed out after ${seconds}s`
    : run.exitCode === 0
      ? `passed in ${seconds}s`
      : `FAILED (exit ${run.exitCode ?? 'none'}) in ${seconds}s`
  return `Tests of ${repo} ${verdict}. Last lines:\n\n${run.output.trim() || '(no output)'}`
}
