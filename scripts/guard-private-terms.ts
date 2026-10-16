/**
 * Fails when a tracked file mentions a private term (a company, customer, person or internal id)
 * listed in `.private-terms`. That file is git-ignored because the list itself is private, so the
 * check only runs where the file exists (the maintainer's machine) and is skipped elsewhere (CI).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const LIST = '.private-terms'

if (!existsSync(LIST)) {
  console.error(`guard-private-terms: ${LIST} not found, skipped.`)
  process.exit(0)
}

const terms = readFileSync(LIST, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file !== '' && file !== 'pnpm-lock.yaml' && existsSync(file))

const hits: string[] = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const term of terms) {
    const pattern = new RegExp(term, 'i')
    lines.forEach((line, index) => {
      if (pattern.test(line))
        hits.push(`${file}:${index + 1}: [${term}] ${line.trim().slice(0, 120)}`)
    })
  }
}

if (hits.length > 0) {
  console.error(
    `Private terms found in ${new Set(hits.map((h) => h.split(':')[0])).size} file(s):\n${hits.join('\n')}`,
  )
  process.exit(1)
}
