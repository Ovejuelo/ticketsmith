import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProjectDatabase } from '#src/core/storage/project-database.ts'

const open = (path: string, iso = '2026-10-15T12:00:00.000Z') => {
  const db = ProjectDatabase.open(path, () => new Date(iso))
  if (!db.ok) throw new Error(db.error.message)
  return db.value
}

describe('ProjectDatabase', () => {
  let dir: string
  let path: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ticketsmith-db-'))
    path = join(dir, 'local', 'project.sqlite')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('creates the file and tracks onboarding steps across reopenings', () => {
    {
      using db = open(path)
      expect(db.steps()).toEqual([])
      db.setStep('tickets', 'pending')
      db.setStep('tickets', 'done', 'OPS: 4 issue types')
    }
    using reopened = open(path)
    expect(reopened.step('tickets')).toEqual({
      step: 'tickets',
      status: 'done',
      updatedAt: '2026-10-15T12:00:00.000Z',
      detail: 'OPS: 4 issue types',
    })
  })

  it('replaces catalog entries of one kind atomically and validates them on read', () => {
    using db = open(path)
    const Schema = z.object({ statuses: z.array(z.string()) })
    db.replaceCatalog('tickets', 'issue-type', [
      { key: 'Bug', data: { statuses: ['Open', 'Done'] } },
      { key: 'Incident', data: { statuses: ['Open'] } },
    ])
    db.replaceCatalog('tickets', 'issue-type', [{ key: 'Bug', data: { statuses: ['Open'] } }])

    expect(db.catalog('tickets', 'issue-type', Schema)).toEqual({
      ok: true,
      value: [
        { key: 'Bug', data: { statuses: ['Open'] }, refreshedAt: '2026-10-15T12:00:00.000Z' },
      ],
    })
    expect(db.catalog('tickets', 'issue-type', z.object({ other: z.number() })).ok).toBe(false)
  })

  it('clears an integration and removes its steps', () => {
    using db = open(path)
    db.replaceCatalog('tickets', 'field', [{ key: 'customfield_1', data: {} }])
    db.setStep('tickets', 'done')
    db.setStep('tickets:sample', 'done')
    db.setStep('repos', 'done')

    db.clearCatalog('tickets')
    db.removeSteps('tickets')
    expect(db.catalog('tickets', 'field', z.object({}))).toEqual({ ok: true, value: [] })
    expect(db.steps().map((step) => step.step)).toEqual(['repos'])
  })

  it('reports an unusable path instead of throwing', () => {
    const result = ProjectDatabase.open('/dev/null/nope/project.sqlite')
    expect(result).toMatchObject({ ok: false, error: { kind: 'storage' } })
  })
})
