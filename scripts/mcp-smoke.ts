/**
 * Smoke test against the real systems: starts `ticketsmith mcp` over stdio with the active
 * profile (VPN/credentials required), lists the tools and calls them like Claude Code would.
 *
 *   pnpm smoke:mcp [TICKET-KEY]
 *
 * Output is masked exactly as the agent sees it. Nothing is written except the audit log.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type TextResult = { content?: { type: string; text?: string }[]; isError?: boolean }
const textOf = (result: unknown): string =>
  ((result as TextResult).content ?? []).map((part) => part.text ?? '').join('')

const key = process.argv[2]
const client = new Client({ name: 'ticketsmith-smoke', version: '1.0.0' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/main.ts', import.meta.url).pathname, 'mcp'],
    stderr: 'inherit',
  }),
)

try {
  const { tools } = await client.listTools()
  console.log(`tools: ${tools.map((tool) => tool.name).join(', ')}\n`)

  const search = await client.callTool({ name: 'jira_search', arguments: { limit: 5 } })
  console.log(`--- jira_search ---\n${textOf(search)}\n`)

  const target = key ?? /\*\*([A-Z][A-Z0-9_]*-\d+)\*\*/.exec(textOf(search))?.[1]
  if (target !== undefined) {
    const issue = await client.callTool({ name: 'jira_get_issue', arguments: { key: target } })
    console.log(`--- jira_get_issue ${target} ---\n${textOf(issue)}`)
  }
} finally {
  await client.close()
}
