import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPlaybook } from '#src/core/agent/load-playbook.ts'

describe('loadPlaybook', () => {
  let knowledge: string
  beforeEach(async () => {
    knowledge = await mkdtemp(join(tmpdir(), 'ticketsmith-playbooks-'))
  })
  afterEach(() => rm(knowledge, { recursive: true, force: true }))

  it('uses the built-in playbook unless the project has its own', async () => {
    const builtIn = await loadPlaybook(knowledge, 'bug')
    expect(builtIn.ok && builtIn.value.source).toBe('built-in')
    expect(builtIn.ok && builtIn.value.text).toMatch(/^# Playbook: investigate a ticket/)

    await mkdir(join(knowledge, 'playbooks'))
    await writeFile(join(knowledge, 'playbooks', 'bug.md'), '# Our bug playbook\n')
    expect(await loadPlaybook(knowledge, 'bug')).toEqual({
      ok: true,
      value: { name: 'bug', text: '# Our bug playbook\n', source: 'project' },
    })
  })

  it('loads project-only playbooks and explains unknown or invalid names', async () => {
    await mkdir(join(knowledge, 'playbooks'))
    await writeFile(join(knowledge, 'playbooks', 'refund.md'), '# Refunds\n')
    expect((await loadPlaybook(knowledge, 'refund')).ok).toBe(true)
    expect(await loadPlaybook(knowledge, 'nope')).toMatchObject({
      ok: false,
      error: expect.stringContaining('add knowledge/playbooks/nope.md'),
    })
    expect((await loadPlaybook(knowledge, '../secret')).ok).toBe(false)
  })

  it('has a built-in playbook for investigations without a ticket', async () => {
    const investigate = await loadPlaybook(knowledge, 'investigate')
    expect(investigate.ok && investigate.value.text).toMatch(/^# Playbook: investigate a question/)
  })
})
