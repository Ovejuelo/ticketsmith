/**
 * Cuts a release: `pnpm release <patch|minor|major> [--dry-run]`.
 *
 * Bumps package.json and the Claude Code plugin manifest together, adds a CHANGELOG entry built
 * from the conventional commits since the last tag, commits, tags `vX.Y.Z` and pushes. The tag
 * starts .github/workflows/release.yml, which publishes to npm and creates the GitHub Release.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const MANIFESTS = ['package.json', 'plugin/.claude-plugin/plugin.json']
const BUMPS = ['patch', 'minor', 'major'] as const
type Bump = (typeof BUMPS)[number]

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()

const die = (message: string): never => {
  console.error(`release: ${message}`)
  process.exit(1)
}

const bumpVersion = (version: string, bump: Bump): string => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['docs', 'Documentation'],
]

/** Groups `type(scope)!: subject` commits into Markdown sections; other types are left out. */
const changelogEntry = (version: string, date: string, subjects: readonly string[]): string => {
  const parsed = subjects.flatMap((subject) => {
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(subject)
    if (match === null) return []
    const [, type = '', scope, breaking, text = ''] = match
    return [{ type, breaking: breaking === '!', line: scope ? `**${scope}:** ${text}` : text }]
  })
  const lines = [`## ${version} — ${date}`, '']
  const breaking = parsed.filter((commit) => commit.breaking)
  if (breaking.length > 0) {
    lines.push('### Breaking changes', '', ...breaking.map((c) => `- ${c.line}`), '')
  }
  for (const [type, title] of SECTIONS) {
    const items = parsed.filter((commit) => commit.type === type && !commit.breaking)
    if (items.length > 0) lines.push(`### ${title}`, '', ...items.map((c) => `- ${c.line}`), '')
  }
  if (lines.length === 2) lines.push('- Maintenance release.', '')
  return lines.join('\n')
}

const bump = process.argv[2] as Bump
const dryRun = process.argv.includes('--dry-run')
if (!BUMPS.includes(bump)) die('usage: pnpm release <patch|minor|major> [--dry-run]')

if (git('branch', '--show-current') !== 'main') die('releases are cut from main')
if (git('status', '--porcelain') !== '') die('the working tree is not clean')

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const next = bumpVersion(pkg.version, bump)
const lastTag = (() => {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd()
  } catch {
    return null
  }
})()
const subjects = git('log', '--format=%s', ...(lastTag === null ? [] : [`${lastTag}..HEAD`]))
  .split('\n')
  .filter((subject) => subject !== '' && !subject.startsWith('chore(release)'))
if (subjects.length === 0) die(`no commits since ${lastTag}`)

const entry = changelogEntry(next, new Date().toISOString().slice(0, 10), subjects)
if (dryRun) {
  console.log(`${pkg.version} → ${next}\n\n${entry}`)
  process.exit(0)
}

execFileSync('pnpm', ['check'], { stdio: 'inherit' })

for (const file of MANIFESTS) {
  const text = readFileSync(file, 'utf8')
  const updated = text.replace(/"version": "[^"]+"/, `"version": "${next}"`)
  if (updated === text) die(`no version field in ${file}`)
  writeFileSync(file, updated)
}
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const firstEntry = changelog.indexOf('\n## ')
if (firstEntry === -1) die('CHANGELOG.md has no entries to insert before')
writeFileSync(
  'CHANGELOG.md',
  `${changelog.slice(0, firstEntry + 1)}${entry}\n${changelog.slice(firstEntry + 1)}`,
)

git('add', 'CHANGELOG.md', ...MANIFESTS)
git('commit', '-m', `chore(release): v${next}`)
git('tag', '-a', `v${next}`, '-m', `v${next}`)
git('push', '--follow-tags', 'origin', 'main')
console.log(`Released v${next}: the release workflow publishes it to npm.`)
