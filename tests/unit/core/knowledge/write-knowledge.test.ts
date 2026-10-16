import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeKnowledge, writeKnowledge } from '#src/core/knowledge/write-knowledge.ts'
import { ALL_MASK_KINDS } from '#src/core/security/index.ts'

const masking = { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true }

describe('writeKnowledge', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ticketsmith-knowledge-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('masks the content before writing it, because knowledge is shared', async () => {
    const result = await writeKnowledge(dir, 'tickets/jira.md', 'Reporter: ana@acme.mx', masking)

    expect(result).toEqual({
      ok: true,
      value: { path: join(dir, 'tickets', 'jira.md'), masked: { email: 1 } },
    })
    expect(await readFile(join(dir, 'tickets', 'jira.md'), 'utf8')).toBe(
      'Reporter: [EMAIL_1]@acme.mx\n',
    )
  })

  it.each(['../outside.md', '/etc/passwd.md', 'notes.txt'])('rejects %s', async (path) => {
    expect((await writeKnowledge(dir, path, 'x', masking)).ok).toBe(false)
  })

  it('removes a subfolder but never the knowledge root', async () => {
    await writeKnowledge(dir, 'tickets/jira.md', 'x', masking)
    expect(await removeKnowledge(dir, 'tickets')).toEqual({ ok: true, value: undefined })
    await expect(stat(join(dir, 'tickets'))).rejects.toThrow()
    expect((await removeKnowledge(dir, '.')).ok).toBe(false)
  })
})
