import { describe, expect, it } from 'vitest'
import { adfToMarkdown } from '#src/core/tickets/adf/adf-to-markdown.ts'
import { markdownToAdf } from '#src/core/tickets/adf/markdown-to-adf.ts'

const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
})

describe('markdownToAdf', () => {
  it('builds paragraphs with inline marks and links', () => {
    expect(
      markdownToAdf(
        'Hola **equipo**, revisen `total()` y _el ticket_ en [JIRA](https://acme.atlassian.net/browse/OPS-1).',
      ),
    ).toEqual({
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text('Hola '),
            text('equipo', [{ type: 'strong' }]),
            text(', revisen '),
            text('total()', [{ type: 'code' }]),
            text(' y '),
            text('el ticket', [{ type: 'em' }]),
            text(' en '),
            text('JIRA', [
              { type: 'link', attrs: { href: 'https://acme.atlassian.net/browse/OPS-1' } },
            ]),
            text('.'),
          ],
        },
      ],
    })
  })

  it('keeps line breaks inside a paragraph and splits paragraphs on blank lines', () => {
    expect(markdownToAdf('Línea uno\nLínea dos\n\nOtro párrafo').content).toEqual([
      { type: 'paragraph', content: [text('Línea uno'), { type: 'hardBreak' }, text('Línea dos')] },
      { type: 'paragraph', content: [text('Otro párrafo')] },
    ])
  })

  it('converts headings, lists, quotes and code blocks', () => {
    const doc = markdownToAdf(
      '## Pasos\n\n1. Uno\n2. Dos\n\n- a\n- b\n\n> Nota\n\n```sql\nSELECT 1;\n```',
    )
    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [text('Pasos')] },
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('Uno')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('Dos')] }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('a')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('b')] }] },
        ],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [text('Nota')] }] },
      { type: 'codeBlock', attrs: { language: 'sql' }, content: [text('SELECT 1;')] },
    ])
  })

  it('never throws on odd input and round-trips through adfToMarkdown', () => {
    expect(() => markdownToAdf('**unclosed *mix_ [x](\n```\nno end')).not.toThrow()
    const markdown = '## Resumen\n\nSe corrigió **el total**.\n\n- Paso uno\n- Paso dos'
    expect(adfToMarkdown(markdownToAdf(markdown))).toContain('**el total**')
  })
})
