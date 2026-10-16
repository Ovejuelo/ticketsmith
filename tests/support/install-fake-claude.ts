import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./fake-claude.ts', import.meta.url).pathname

export type FakeClaudeCall = { args: string[]; cwd: string; secretVisible: boolean }

/** An executable `claude` stand-in (a shell shim running fake-claude.ts) and its call log. */
export class FakeClaudeBinary implements Disposable {
  readonly dir = mkdtempSync(join(tmpdir(), 'ticketsmith-fake-claude-'))
  readonly command = join(this.dir, 'claude')
  readonly log = join(this.dir, 'calls.jsonl')

  constructor() {
    writeFileSync(this.command, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`)
    chmodSync(this.command, 0o755)
    writeFileSync(this.log, '')
  }

  env(scenario: string, output?: unknown): NodeJS.ProcessEnv {
    return {
      ...process.env,
      FAKE_CLAUDE_LOG: this.log,
      FAKE_CLAUDE_SCENARIO: scenario,
      TICKETSMITH_DB_SHARD1: 'db-password',
      ...(output === undefined ? {} : { FAKE_CLAUDE_OUTPUT: JSON.stringify(output) }),
    }
  }

  calls(): FakeClaudeCall[] {
    return readFileSync(this.log, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as FakeClaudeCall)
  }

  [Symbol.dispose](): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}
