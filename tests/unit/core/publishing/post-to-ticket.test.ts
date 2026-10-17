import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTransition,
  findTransition,
  postComment,
  readComment,
  suggestedTransition,
} from '#src/core/publishing/index.ts'
import { TicketKeySchema } from '#src/core/tickets/index.ts'
import { FakeTicketWriter } from '#tests/support/fake-ticket-writer.ts'
import { InMemoryAuditLog } from '#tests/support/in-memory-audit-log.ts'

const KEY = TicketKeySchema.parse('OPS-7')

describe('posting to a ticket', () => {
  let out: string
  const shown: string[] = []
  const answering = (yes: boolean) => ({ show: (t: string) => shown.push(t), ask: async () => yes })
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'ticketsmith-post-'))
    await mkdir(join(out, 'OPS-7'))
    await writeFile(join(out, 'OPS-7', 'jira_comment.md'), 'Hola, ya quedó.\n')
    await writeFile(
      join(out, 'OPS-7', 'analysis.md'),
      '# OPS-7: analysis\n\n**Type:** bug\n\n**Suggested transition:** Done\n',
    )
    shown.length = 0
  })
  afterEach(() => rm(out, { recursive: true, force: true }))

  it('shows the exact text, posts only on yes, and audits without the text', async () => {
    const writer = new FakeTicketWriter()
    const audit = new InMemoryAuditLog()
    const text = await readComment(out, 'OPS-7', undefined)
    if (!text.ok) throw new Error(text.error)

    expect(await postComment(writer, audit, out, KEY, text.value, answering(false))).toEqual({
      ok: true,
      value: null,
    })
    expect(writer.comments).toEqual([])

    const posted = await postComment(writer, audit, out, KEY, text.value, answering(true))
    expect(posted).toEqual({
      ok: true,
      value: 'https://example.atlassian.net/browse/OPS-7?focusedCommentId=10001',
    })
    expect(shown[1]).toContain('Hola, ya quedó.')
    expect(writer.comments).toEqual([{ key: 'OPS-7', markdown: 'Hola, ya quedó.' }])
    expect(audit.entries[0]).toMatchObject({
      tool: 'ticket_comment',
      ok: true,
      input: { ticket: 'OPS-7', chars: 15 },
    })
    expect(JSON.stringify(audit.entries)).not.toContain('ya quedó')
    expect(
      JSON.parse(await readFile(join(out, 'OPS-7', 'jira_comment.posted.json'), 'utf8')).url,
    ).toContain('focusedCommentId')
  })

  it('explains a missing comment and finds transitions by name or status', async () => {
    expect((await readComment(out, 'OPS-8', undefined)).ok).toBe(false)
    const writer = new FakeTicketWriter()
    expect(findTransition(writer.available, 'done')?.id).toBe('31')
    expect(findTransition(writer.available, 'Start progress')?.id).toBe('21')
    expect(await suggestedTransition(out, 'OPS-7')).toBe('Done')

    const audit = new InMemoryAuditLog()
    expect(
      await applyTransition(
        writer,
        audit,
        KEY,
        writer.available[1] ?? { id: '', name: '', to: '' },
        answering(true),
      ),
    ).toEqual({ ok: true, value: true })
    expect(writer.moved).toEqual([{ key: 'OPS-7', transitionId: '31' }])
    expect(audit.entries[0]).toMatchObject({ tool: 'ticket_transition', input: { to: 'Done' } })
  })
})
