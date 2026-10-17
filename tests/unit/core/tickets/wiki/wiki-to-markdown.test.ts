import { describe, expect, it } from 'vitest'
import { markdownToWiki } from '#src/core/tickets/wiki/markdown-to-wiki.ts'
import { wikiToMarkdown } from '#src/core/tickets/wiki/wiki-to-markdown.ts'

describe('wikiToMarkdown', () => {
  it('converts a typical Data Center description', () => {
    const wiki = [
      'h2. Steps to reproduce',
      '# Open the *billing* screen for [~ana.lopez]',
      '# Click _Charge_ on invoice {{INV-2041}}',
      '## It fails with -no- a timeout',
      '* See [the runbook|https://wiki.example.com/runbook]',
      '** and [https://status.example.com]',
      '',
      '{code:sql}',
      "SELECT * FROM invoices WHERE folio = 'A-1' -- *not* bold",
      '{code}',
      '{noformat}raw *text*{noformat}',
      'bq. The customer says it worked yesterday.',
      '||Field||Value||',
      '|status|[failed|https://x.example.com/f]|',
      '|amount|1,200.00|',
      '----',
      'Screenshot: !error.png|thumbnail! line\\\\break',
    ].join('\n')
    expect(wikiToMarkdown(wiki)).toBe(
      [
        '## Steps to reproduce',
        '1. Open the **billing** screen for @ana.lopez',
        '1. Click *Charge* on invoice `INV-2041`',
        '  1. It fails with ~~no~~ a timeout',
        '- See [the runbook](https://wiki.example.com/runbook)',
        '  - and <https://status.example.com>',
        '',
        '```sql',
        "SELECT * FROM invoices WHERE folio = 'A-1' -- *not* bold",
        '```',
        '```',
        'raw *text*',
        '```',
        '> The customer says it worked yesterday.',
        '| Field | Value |',
        '| --- | --- |',
        '| status | [failed](https://x.example.com/f) |',
        '| amount | 1,200.00 |',
        '---',
        'Screenshot: [attachment: error.png] line  \nbreak',
      ].join('\n'),
    )
  })

  it('converts quotes and panels, and keeps unknown markup as text', () => {
    expect(wikiToMarkdown('{quote}\nIt *broke*.\n{quote}')).toBe('> It **broke**.')
    expect(wikiToMarkdown('{panel:title=Note|borderStyle=dashed}\nCareful.\n{panel}')).toBe(
      '**Note**\nCareful.',
    )
    expect(wikiToMarkdown('{color:red}urgent{color} {unknown-macro} 2026-10-16 -5 to -3')).toBe(
      'urgent {unknown-macro} 2026-10-16 -5 to -3',
    )
    expect(wikiToMarkdown('snake_case_name and a*b*c')).toBe('snake_case_name and a*b*c')
  })

  it('never throws and keeps the text of unterminated blocks', () => {
    expect(wikiToMarkdown('{code}\nunterminated')).toBe('```\nunterminated\n```')
    expect(wikiToMarkdown('')).toBe('')
    expect(() => wikiToMarkdown('[|]{{}}!!||||**__--')).not.toThrow()
  })
})

describe('markdownToWiki', () => {
  it('converts what Ticketsmith writes in jira_comment.md', () => {
    const markdown = [
      '## Probable cause',
      '',
      'The **card** of [EMAIL_1]@northwind.mx *expired*; see `billing/charge.js:42`.',
      '',
      '- Check [the logs](https://logs.example.com)',
      '  - then retry',
      '1. Renew the card',
      '',
      '```sql',
      'SELECT * FROM cards WHERE id = 7',
      '```',
      '',
      '> Reported by the customer',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| status | ~~active~~ expired |',
      '',
      '---',
    ].join('\n')
    expect(markdownToWiki(markdown)).toBe(
      [
        'h2. Probable cause',
        '',
        'The *card* of [EMAIL_1]@northwind.mx _expired_; see {{billing/charge.js:42}}.',
        '',
        '* Check [the logs|https://logs.example.com]',
        '** then retry',
        '# Renew the card',
        '',
        '{code:sql}',
        'SELECT * FROM cards WHERE id = 7',
        '{code}',
        '',
        'bq. Reported by the customer',
        '',
        '||Field||Value||',
        '|status|-active- expired|',
        '',
        '----',
      ].join('\n'),
    )
  })

  it('round-trips the common markup through wiki and back', () => {
    const markdown =
      '# Title\n\n- **bold** and *italic* with `code`\n- [link](https://a.example.com)'
    expect(wikiToMarkdown(markdownToWiki(markdown))).toBe(markdown)
  })
})
