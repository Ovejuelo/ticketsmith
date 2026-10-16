import { Command } from 'commander'
import pc from 'picocolors'
import { type CommandDeps, fail, globalOptions } from '../../core/cli/index.ts'
import { type CheckStatus, runChecks } from './run-checks.ts'

const SYMBOLS: Record<CheckStatus, string> = {
  ok: pc.green('✔'),
  warn: pc.yellow('⚠'),
  fail: pc.red('✖'),
  skip: pc.dim('·'),
}

export const doctorCommand = ({ io, servicesFor }: CommandDeps): Command =>
  new Command('doctor')
    .description('Check the project and every configured integration')
    .action(async (_, command: Command) => {
      const global = globalOptions(command)
      const checks = await runChecks(servicesFor(command), global.project)

      if (global.json) {
        io.out(`${JSON.stringify(checks, null, 2)}\n`)
      } else {
        io.out(
          `${checks.map((c) => `${SYMBOLS[c.status]} ${pc.bold(c.name)}: ${c.detail}`).join('\n')}\n`,
        )
      }
      if (checks.some((check) => check.status === 'fail')) fail('Some checks failed.')
    })
