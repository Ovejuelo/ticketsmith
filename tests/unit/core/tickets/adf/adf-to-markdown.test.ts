import { describe, expect, it } from 'vitest'
import type { AdfNode } from '#src/core/tickets/adf/adf.schema.ts'
import { adfToMarkdown } from '#src/core/tickets/adf/adf-to-markdown.ts'

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content })
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content })
const text = (value: string, ...marks: AdfNode['marks'] & {}): AdfNode =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content })

describe('adfToMarkdown', () => {
  it('returns an empty string for null', () => {
    expect(adfToMarkdown(null)).toBe('')
  })

  it('separates paragraphs with a blank line', () => {
    expect(adfToMarkdown(doc(p(text('One')), p(text('Two'))))).toBe('One\n\nTwo')
  })

  it('renders headings, clamping the level', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
          { type: 'heading', attrs: { level: 9 }, content: [text('Deep')] },
        ),
      ),
    ).toBe('## Title\n\n###### Deep')
  })

  it('applies text marks and keeps surrounding spaces outside them', () => {
    const md = adfToMarkdown(
      doc(
        p(
          text('bold ', { type: 'strong' }),
          text('italic', { type: 'em' }),
          text(' '),
          text('gone', { type: 'strike' }),
          text(' '),
          text('x = 1', { type: 'code' }, { type: 'strong' }),
          text(' '),
          text('site', { type: 'link', attrs: { href: 'https://example.com' } }),
        ),
      ),
    )
    expect(md).toBe('**bold** _italic_ ~~gone~~ `x = 1` [site](https://example.com)')
  })

  it('renders hard breaks, mentions, emojis, dates, status and inline cards', () => {
    const md = adfToMarkdown(
      doc(
        p(
          text('Hi'),
          { type: 'hardBreak' },
          { type: 'mention', attrs: { id: 'abc', text: '@Jane Doe' } },
          text(' '),
          { type: 'mention', attrs: { id: 'xyz' } },
          text(' '),
          { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
          text(' '),
          { type: 'date', attrs: { timestamp: '1760486400000' } },
          text(' '),
          { type: 'status', attrs: { text: 'IN REVIEW', color: 'blue' } },
          text(' '),
          { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/X-1' } },
        ),
      ),
    )
    expect(md).toBe(
      'Hi\n@Jane Doe @xyz 😄 2025-10-15 [status: IN REVIEW] <https://acme.atlassian.net/browse/X-1>',
    )
  })

  it('renders nested bullet and ordered lists', () => {
    const md = adfToMarkdown(
      doc({
        type: 'orderedList',
        attrs: { order: 3 },
        content: [
          li(p(text('First')), { type: 'bulletList', content: [li(p(text('Nested')))] }),
          li(p(text('Second'))),
        ],
      }),
    )
    expect(md).toBe('3. First\n   - Nested\n4. Second')
  })

  it('renders task lists', () => {
    const md = adfToMarkdown(
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Done')] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('Todo')] },
        ],
      }),
    )
    expect(md).toBe('- [x] Done\n- [ ] Todo')
  })

  it('renders code blocks with language and a fence longer than any inner fence', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'codeBlock', attrs: { language: 'sql' }, content: [text('SELECT 1;')] }),
      ),
    ).toBe('```sql\nSELECT 1;\n```')

    expect(adfToMarkdown(doc({ type: 'codeBlock', content: [text('a ``` b')] }))).toBe(
      '````\na ``` b\n````',
    )
  })

  it('renders blockquotes, rules and panels', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'blockquote', content: [p(text('Quoted')), p(text('Twice'))] },
        { type: 'rule' },
        { type: 'panel', attrs: { panelType: 'warning' }, content: [p(text('Careful'))] },
      ),
    )
    expect(md).toBe('> Quoted\n>\n> Twice\n\n---\n\n> **Warning:** Careful')
  })

  it('renders tables, escaping pipes and padding short rows', () => {
    const cell = (type: string, value: string): AdfNode => ({ type, content: [p(text(value))] })
    const md = adfToMarkdown(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Id'), cell('tableHeader', 'Name')] },
          { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', 'a|b')] },
          { type: 'tableRow', content: [cell('tableCell', '2')] },
        ],
      }),
    )
    expect(md).toBe('| Id | Name |\n| --- | --- |\n| 1 | a\\|b |\n| 2 |  |')
  })

  it('references media as attachments', () => {
    const md = adfToMarkdown(
      doc(
        {
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { id: 'm1', type: 'file', alt: 'error.png' } }],
        },
        { type: 'mediaGroup', content: [{ type: 'media', attrs: { id: 'm2', type: 'file' } }] },
      ),
    )
    expect(md).toBe('[attachment: error.png]\n\n[attachment: m2]')
  })

  it('renders expands with their title', () => {
    const md = adfToMarkdown(
      doc({ type: 'expand', attrs: { title: 'Logs' }, content: [p(text('stack trace'))] }),
    )
    expect(md).toBe('**Logs**\n\nstack trace')
  })

  it('degrades unknown nodes to their text instead of throwing', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'futureBlock', content: [p(text('inside'))] },
        p(text('a '), { type: 'futureInline', content: [text('b')] }, { type: 'emptyThing' }),
      ),
    )
    expect(md).toBe('inside\n\na b')
  })
})
