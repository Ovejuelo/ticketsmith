import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '#src/core/cli/index.ts'
import type { ProjectPaths } from '#src/core/project/index.ts'
import { FakeCli, testProject } from '#tests/support/fake-cli.ts'

describe('ticketsmith knowledge add', () => {
  let cli: FakeCli
  let paths: ProjectPaths
  beforeEach(async () => {
    cli = await (await FakeCli.create()).withProject(testProject())
    paths = (await openProject(cli.services, undefined)).paths
  })
  afterEach(() => cli.cleanup())

  it('builds the case from the outputs and the note, masked', async () => {
    const out = join(paths.outDir, 'OPS-7')
    await mkdir(join(out, 'change-cr-0000000a'), { recursive: true })
    await writeFile(
      join(out, 'classification.json'),
      JSON.stringify({
        ticket: 'OPS-7',
        type: 'service-request',
        confidence: 0.9,
        source: 'llm',
        reason: 'Close the account.',
      }),
    )
    await writeFile(
      join(out, 'analysis.md'),
      '# OPS-7: analysis\n\n## Summary\n\nThe customer ana@northwind.mx wants the account closed.\n\n## Probable cause\n\nA request, not a bug.\n\n## Evidence\n\n- x\n',
    )
    await writeFile(
      join(out, 'change-cr-0000000a', 'change.sql'),
      "UPDATE `accounts` SET `status` = 'inactive' WHERE `email` = 'ana@northwind.mx';\n",
    )
    await writeFile(join(out, 'change-cr-0000000a', 'result.json'), '{"status":"executed"}')

    expect(
      await cli.run(
        'knowledge',
        'add',
        'ops-7',
        '--note',
        'Deactivated after the customer confirmed by phone +52 55 1234 5678.',
      ),
    ).toBeNull()

    const text = await readFile(join(paths.knowledgeDir, 'cases', 'OPS-7.md'), 'utf8')
    expect(text).toMatch(/^---\nticket: OPS-7\ntype: service-request\nclassifiedBy: llm\n/)
    expect(text).toContain(
      '## Investigation\n\nThe customer [EMAIL_1]@northwind.mx wants the account closed.',
    )
    expect(text).toContain('**Probable cause:** A request, not a bug.')
    expect(text).toContain("SET `status` = 'inactive' WHERE `email` = '[EMAIL_1]@northwind.mx'")
    expect(text).toContain('-- executed')
    expect(text).toContain('Deactivated after the customer confirmed by phone [PHONE_1].')
    expect(text).not.toContain('ana@northwind.mx')
    expect(cli.stdout).toContain('Saved knowledge/cases/OPS-7.md')
  })

  it('explains when there is nothing to build a case from', async () => {
    expect((await cli.run('knowledge', 'add', 'OPS-9'))?.message).toMatch(/Nothing in out\/OPS-9\//)
  })
})
