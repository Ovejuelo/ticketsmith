/**
 * Fails when a file under src/, tests/, scripts/ or docs/ is ignored by git. An unanchored
 * .gitignore pattern (like `audit/`) once kept src/core/audit/index.ts out of the repo while
 * everything passed locally; this check catches that before a commit.
 */
import { execFileSync } from 'node:child_process'

const ignored = execFileSync(
  'git',
  ['ls-files', '--others', '--ignored', '--exclude-standard', 'src', 'tests', 'scripts', 'docs'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((line) => line.trim() !== '')

if (ignored.length > 0) {
  console.error(`These project files are ignored by git (fix .gitignore):\n${ignored.join('\n')}`)
  process.exit(1)
}
