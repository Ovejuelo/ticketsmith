/** An ADF node as JIRA Cloud accepts it in comments. */
export type AdfOut = {
  readonly type: string
  readonly attrs?: Readonly<Record<string, unknown>>
  readonly content?: readonly AdfOut[]
  readonly text?: string
  readonly marks?: readonly {
    readonly type: string
    readonly attrs?: Readonly<Record<string, unknown>>
  }[]
}

export type AdfDoc = {
  readonly version: 1
  readonly type: 'doc'
  readonly content: readonly AdfOut[]
}

type Mark = NonNullable<AdfOut['marks']>[number]

// One alternative per inline construct; the first that matches at a position wins.
const INLINE =
  /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/g

const textNode = (text: string, marks?: Mark[]): AdfOut =>
  marks === undefined ? { type: 'text', text } : { type: 'text', text, marks }

/** Bold, italic, inline code and links; anything else stays plain text. */
const inline = (line: string): AdfOut[] => {
  const nodes: AdfOut[] = []
  let last = 0
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(textNode(line.slice(last, index)))
    const [, bold, code, label, href, star, underscore] = match
    if (bold !== undefined) nodes.push(textNode(bold, [{ type: 'strong' }]))
    else if (code !== undefined) nodes.push(textNode(code, [{ type: 'code' }]))
    else if (label !== undefined && href !== undefined)
      nodes.push(textNode(label, [{ type: 'link', attrs: { href } }]))
    else nodes.push(textNode(star ?? underscore ?? '', [{ type: 'em' }]))
    last = index + match[0].length
  }
  if (last < line.length) nodes.push(textNode(line.slice(last)))
  return nodes
}

/** Lines of one paragraph, joined by hard breaks (comments keep their line breaks). */
const paragraph = (lines: readonly string[]): AdfOut => ({
  type: 'paragraph',
  content: lines.flatMap((line, i) =>
    i === 0 ? inline(line) : [{ type: 'hardBreak' }, ...inline(line)],
  ),
})

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/

/**
 * Markdown (as the agent writes jira_comment.md) to Atlassian Document Format: paragraphs,
 * headings, bullet and numbered lists, quotes, code blocks, bold, italic, inline code and links.
 * Never throws: whatever it does not recognize is kept as plain text.
 */
export const markdownToAdf = (markdown: string): AdfDoc => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const content: AdfOut[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++ // closing fence (or end of input)
      content.push({
        type: 'codeBlock',
        attrs: fence[1] ? { language: fence[1] } : {},
        content: body.length > 0 ? [textNode(body.join('\n'))] : [],
      })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1]?.length ?? 1 },
        content: inline(heading[2] ?? ''),
      })
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? ''))
        quoted.push((lines[i++] ?? '').replace(/^>\s?/, ''))
      content.push({ type: 'blockquote', content: [paragraph(quoted)] })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      const ordered = /\d/.test(item[1] ?? '')
      const items: AdfOut[] = []
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i] ?? '')
        if (current === null || /\d/.test(current[1] ?? '') !== ordered) break
        items.push({ type: 'listItem', content: [paragraph([current[2] ?? ''])] })
        i++
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items })
      continue
    }
    const block: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (current.trim() === '' || /^(```|#{1,6}\s|>)/.test(current) || LIST_ITEM.test(current))
        break
      block.push(current)
      i++
    }
    content.push(paragraph(block))
  }
  return { version: 1, type: 'doc', content }
}
