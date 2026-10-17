import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'

describe('ticketsmith comment | transition', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await FakeCli.create()
  })
  afterEach(() => cli.cleanup())

  it('never posts without a terminal or with writes off', async () => {
    await cli.withProject(testProject({ allowWrites: true }))
    expect((await cli.run('comment', 'OPS-7'))?.message).toMatch(/interactive terminal/)
    expect((await cli.run('transition', 'OPS-7', 'Done'))?.message).toMatch(/interactive terminal/)
    expect(cli.writer.comments).toEqual([])
  })
})
