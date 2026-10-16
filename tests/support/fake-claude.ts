/**
 * Stands in for the `claude` binary in tests (see installFakeClaude). It records how it was called
 * in $FAKE_CLAUDE_LOG and behaves as $FAKE_CLAUDE_SCENARIO says.
 */
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env['FAKE_CLAUDE_LOG']
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ args, cwd: process.cwd(), secretVisible: process.env['TICKETSMITH_DB_SHARD1'] !== undefined })}\n`,
  )
}

const result = (fields: Record<string, unknown>) =>
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      total_cost_usd: 0.42,
      num_turns: 7,
      duration_ms: 12_345,
      session_id: 'session-1',
      ...fields,
    }),
  )

if (args[0] === '--version') {
  process.stdout.write('2.1.301 (Claude Code)\n')
} else if (args[0] === 'auth') {
  process.stdout.write(
    JSON.stringify({
      loggedIn: process.env['FAKE_CLAUDE_SCENARIO'] !== 'logged-out',
      authMethod: 'claude.ai',
    }),
  )
} else {
  switch (process.env['FAKE_CLAUDE_SCENARIO']) {
    case 'budget':
      result({
        subtype: 'error_max_budget_usd',
        is_error: true,
        total_cost_usd: 3.1,
        errors: ['Reached maximum budget ($3)'],
      })
      process.exitCode = 1
      break
    case 'logged-out':
      result({ subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
      process.exitCode = 1
      break
    case 'crash':
      process.stderr.write('Error: something broke\n')
      process.exitCode = 2
      break
    case 'hang':
      setTimeout(() => {}, 60_000)
      break
    case 'no-structured':
      result({ result: 'plain text only' })
      break
    default:
      result({
        structured_output: JSON.parse(process.env['FAKE_CLAUDE_OUTPUT'] ?? '{"answer":"ok"}'),
      })
  }
}
