import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli } from '#tests/support/fake-cli.ts'
import { InMemoryTicketSource } from '#tests/support/in-memory-ticket-source.ts'
import { makeTicket } from '#tests/support/ticket-factory.ts'

describe('ticketsmith show', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject()
    cli.source = new InMemoryTicketSource([makeTicket('OPS-1')])
  })
  afterEach(() => cli.cleanup())

  it('prints the ticket as Markdown using the stored token', async () => {
    expect(await cli.run('show', 'ops-1')).toBeNull()
    expect(cli.stdout).toMatch(/^# OPS-1: Summary of OPS-1\n/)
    expect(cli.connections[0]?.token).toBe('secret-token')
  })

  it('prints JSON with --json', async () => {
    await cli.run('--json', 'show', 'OPS-1')
    expect(JSON.parse(cli.stdout)).toMatchObject({ key: 'OPS-1', type: 'Bug' })
  })

  it('saves ticket.md and ticket.json with --out', async () => {
    await cli.run('show', 'OPS-1', '--out')
    const dir = join(cli.home, '.local/share/ticketsmith/projects/acme/local/out/OPS-1')
    expect(cli.stderr).toContain(dir)
    expect(await readFile(join(dir, 'ticket.md'), 'utf8')).toBe(cli.stdout)
    expect(JSON.parse(await readFile(join(dir, 'ticket.json'), 'utf8')).key).toBe('OPS-1')
  })

  it('fails clearly for unknown or malformed keys', async () => {
    expect((await cli.run('show', 'OPS-9'))?.message).toMatch(/Not found: OPS-9/)
    expect((await cli.run('show', 'nope'))?.message).toMatch(/Invalid ticket key/)
  })

  it('asks for init when there is no token', async () => {
    cli.secrets.values.clear()
    expect((await cli.run('show', 'OPS-1'))?.message).toMatch(
      /No JIRA token found.*project add tickets/,
    )
  })
})

describe('ticketsmith show --mask', () => {
  it('masks the output and reports what was masked on stderr', async () => {
    const cli = await (await FakeCli.create()).withProject()
    cli.source = new InMemoryTicketSource([
      makeTicket('OPS-1', { description: 'Contacto: ana@acme.mx, tel +52 55 1234 5678' }),
    ])

    await cli.run('show', 'OPS-1', '--mask')
    expect(cli.stdout).toContain('Contacto: [EMAIL_1]@acme.mx, tel [PHONE_1]')
    expect(cli.stdout).not.toContain('ana@acme.mx')
    expect(cli.stderr).toBe('Masked: email 1, phone 1\n')
    await cli.cleanup()
  })
})
