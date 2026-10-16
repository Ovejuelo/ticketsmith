import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ok } from '../../core/kernel/index.ts'
import { defineTool, reposContext } from '../../core/mcp/index.ts'
import { isCloned, resolveCommit } from '../../core/repos/index.ts'

const lastFetch = async (dir: string): Promise<string | null> => {
  try {
    return (await stat(join(dir, '.git', 'FETCH_HEAD'))).mtime.toISOString()
  } catch {
    return null
  }
}

export const listTool = defineTool({
  name: 'repo_list',
  title: 'List the project repositories',
  description:
    'List the git repositories of this project: clone URL, base branches, the commit the local clone is at, runtime, test command and the knowledge map to read first (knowledge/repos/<name>.md). The clones are read-only mirrors of the fix branch.',
  inputSchema: {},
  requires: ['repos'],
  readOnly: true,
  run: async (_input, context) => {
    const repos = reposContext(context)
    if (!repos.ok) return repos
    const blocks = await Promise.all(
      repos.value.repositories.map(async ({ config, dir }) => {
        const head = isCloned(dir) ? await resolveCommit(dir, 'HEAD') : null
        const fetched = head === null ? null : await lastFetch(dir)
        return [
          `## ${config.name}`,
          `- URL: ${config.url}`,
          `- Branches: fixes from \`${config.branches.fix}\`, features from \`${config.branches.feature}\`; protected: ${config.protectedBranches.join(', ')}`,
          head === null
            ? '- Clone: not cloned yet (run `ticketsmith project refresh repos`)'
            : head.ok
              ? `- Clone: ${config.branches.fix} at ${head.value.id.slice(0, 12)} (${head.value.date})${fetched === null ? '' : `, fetched ${fetched}`}`
              : `- Clone: ${head.error}`,
          `- Runtime: ${config.runtime.node === undefined ? 'not set' : `Node ${config.runtime.node}`}`,
          `- Tests: ${config.testCommand === undefined ? 'not set' : `\`${config.testCommand}\``}`,
          `- Map: knowledge/repos/${config.name}.md`,
        ].join('\n')
      }),
    )
    return ok(blocks.join('\n\n'))
  },
})
