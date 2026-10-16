import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonlAuditLog } from '#src/core/audit/jsonl-audit-log.ts'

describe('JsonlAuditLog', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ticketsmith-audit-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const entry = { tool: 'jira_get_issue', input: { key: 'OPS-1' }, ok: true, durationMs: 12 }

  it('appends owner-only JSON lines with context', async () => {
    const log = new JsonlAuditLog({
      dir: join(root, 'audit'),
      command: 'mcp',
      project: 'acme',
      onError: () => {},
      now: () => new Date('2026-10-15T12:00:00.000Z'),
      pid: 42,
    })
    await log.record(entry)
    await log.record({ ...entry, ok: false, error: 'not-found' })

    expect(log.file).toBe(join(root, 'audit', '2026-10-15-mcp-42.jsonl'))
    const lines = (await readFile(log.file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { ts: '2026-10-15T12:00:00.000Z', command: 'mcp', project: 'acme', ...entry },
      {
        ts: '2026-10-15T12:00:00.000Z',
        command: 'mcp',
        project: 'acme',
        ...entry,
        ok: false,
        error: 'not-found',
      },
    ])
    expect((await stat(log.file)).mode & 0o777).toBe(0o600)
  })

  it('reports write failures instead of throwing', async () => {
    const blocker = join(root, 'not-a-dir')
    await writeFile(blocker, '')
    const onError = vi.fn()
    const log = new JsonlAuditLog({
      dir: join(blocker, 'audit'),
      command: 'mcp',
      project: 'acme',
      onError,
    })

    await expect(log.record(entry)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })
})
