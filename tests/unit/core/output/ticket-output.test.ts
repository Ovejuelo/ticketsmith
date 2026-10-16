import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketOutputDir, writeOutputFiles } from '#src/core/output/ticket-output.ts'

describe('writeOutputFiles', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ticketsmith-out-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('writes owner-only files under <out>/<KEY>', async () => {
    const dir = ticketOutputDir(root, 'OPS-1')
    const result = await writeOutputFiles(dir, { 'ticket.md': '# OPS-1\n' })

    expect(result).toEqual({ ok: true, value: [join(root, 'OPS-1', 'ticket.md')] })
    expect(await readFile(join(dir, 'ticket.md'), 'utf8')).toBe('# OPS-1\n')
    expect((await stat(join(dir, 'ticket.md'))).mode & 0o777).toBe(0o600)
  })
})
