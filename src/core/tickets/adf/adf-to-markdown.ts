import type { AdfMark, AdfNode } from './adf.schema.ts'

/**
 * Converts an ADF document to Markdown for humans and LLMs. Pure and total: unknown nodes
 * degrade to their text content and nothing throws. Plain text is not escaped on purpose;
 * readers are people and models, and escaping would mangle code-like ticket content.
 */
export const adfToMarkdown = (doc: AdfNode | null): string =>
  doc === null
    ? ''
    : renderBlock(doc)
        .replace(/\n{3,}/g, '\n\n')
        .trim()

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'mediaInline',
  'placeholder',
  'inlineExtension',
])

const childrenOf = (node: AdfNode): readonly AdfNode[] => node.content ?? []

const attr = (node: AdfNode | AdfMark, name: string): string | undefined => {
  const value = node.attrs?.[name]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

// Containers may mix block and inline nodes; consecutive inline nodes form one paragraph.
const renderChildren = (nodes: readonly AdfNode[], separator = '\n\n'): string => {
  const parts: string[] = []
  let inlineRun: AdfNode[] = []
  const flush = () => {
    if (inlineRun.length > 0) parts.push(renderInline(inlineRun))
    inlineRun = []
  }
  for (const node of nodes) {
    if (INLINE_TYPES.has(node.type)) {
      inlineRun.push(node)
    } else {
      flush()
      parts.push(renderBlock(node))
    }
  }
  flush()
  return parts.filter((part) => part.trim() !== '').join(separator)
}

const renderBlock = (node: AdfNode): string => {
  switch (node.type) {
    case 'doc':
      return renderChildren(childrenOf(node))
    case 'paragraph':
      return renderInline(childrenOf(node))
    case 'heading': {
      const level = Math.min(Math.max(Number(attr(node, 'level') ?? 1) || 1, 1), 6)
      return `${'#'.repeat(level)} ${renderInline(childrenOf(node))}`
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node)
    case 'taskList':
      return childrenOf(node)
        .map((item) => {
          const checked = attr(item, 'state') === 'DONE' ? 'x' : ' '
          return indentContinuation(`- [${checked}] ${renderChildren(childrenOf(item), '\n')}`, 2)
        })
        .join('\n')
    case 'decisionList':
      return childrenOf(node)
        .map((item) => `- ${renderChildren(childrenOf(item), '\n')}`)
        .join('\n')
    case 'codeBlock':
      return renderCodeBlock(node)
    case 'blockquote':
      return quote(renderChildren(childrenOf(node)))
    case 'rule':
      return '---'
    case 'panel': {
      const kind = attr(node, 'panelType') ?? 'note'
      const title = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
      return quote(`**${title}:** ${renderChildren(childrenOf(node))}`)
    }
    case 'table':
      return renderTable(node)
    case 'mediaSingle':
    case 'mediaGroup':
      return childrenOf(node).map(renderMedia).join('\n')
    case 'media':
      return renderMedia(node)
    case 'expand':
    case 'nestedExpand': {
      const title = attr(node, 'title')
      const body = renderChildren(childrenOf(node))
      return title ? `**${title}**\n\n${body}` : body
    }
    case 'blockCard':
    case 'embedCard': {
      const url = attr(node, 'url')
      return url ? `<${url}>` : ''
    }
    case 'extension':
      return `[extension: ${attr(node, 'extensionKey') ?? 'unknown'}]`
    default:
      if (INLINE_TYPES.has(node.type)) return renderInline([node])
      return renderChildren(childrenOf(node)) || (node.text ?? '')
  }
}

const renderList = (node: AdfNode): string => {
  const ordered = node.type === 'orderedList'
  const start = Number(attr(node, 'order') ?? 1) || 1
  return childrenOf(node)
    .map((item, index) => {
      const marker = ordered ? `${start + index}.` : '-'
      return indentContinuation(
        `${marker} ${renderChildren(childrenOf(item), '\n')}`,
        marker.length + 1,
      )
    })
    .join('\n')
}

const indentContinuation = (text: string, width: number): string =>
  text
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : `${' '.repeat(width)}${line}`))
    .join('\n')

const quote = (markdown: string): string =>
  markdown
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')

const renderCodeBlock = (node: AdfNode): string => {
  const code = childrenOf(node)
    .map((child) => child.text ?? '')
    .join('')
  const longestRun = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}${attr(node, 'language') ?? ''}\n${code}\n${fence}`
}

const renderTable = (node: AdfNode): string => {
  const rows = childrenOf(node)
    .filter((row) => row.type === 'tableRow')
    .map((row) => childrenOf(row).map((cell) => escapeCell(renderChildren(childrenOf(cell)))))
  const [header, ...body] = rows
  if (header === undefined) return ''

  const width = Math.max(...rows.map((row) => row.length))
  const line = (cells: readonly string[]) =>
    `| ${[...cells, ...Array<string>(width - cells.length).fill('')].join(' | ')} |`
  const divider = `| ${Array<string>(width).fill('---').join(' | ')} |`
  return [line(header), divider, ...body.map(line)].join('\n')
}

const escapeCell = (markdown: string): string =>
  markdown.replaceAll('|', '\\|').replace(/\n+/g, '<br>')

const renderMedia = (node: AdfNode): string =>
  `[attachment: ${attr(node, 'alt') ?? attr(node, 'id') ?? 'file'}]`

const renderInline = (nodes: readonly AdfNode[]): string => nodes.map(renderInlineNode).join('')

const renderInlineNode = (node: AdfNode): string => {
  switch (node.type) {
    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? [])
    case 'hardBreak':
      return '\n'
    case 'mention': {
      const name = attr(node, 'text') ?? attr(node, 'id') ?? 'unknown'
      return name.startsWith('@') ? name : `@${name}`
    }
    case 'emoji':
      return attr(node, 'text') ?? attr(node, 'shortName') ?? ''
    case 'date':
      return formatTimestamp(attr(node, 'timestamp'))
    case 'status':
      return `[status: ${attr(node, 'text') ?? ''}]`
    case 'inlineCard': {
      const url = attr(node, 'url')
      return url ? `<${url}>` : ''
    }
    case 'mediaInline':
      return renderMedia(node)
    case 'placeholder':
      return ''
    default:
      return node.text ?? renderInline(childrenOf(node))
  }
}

const formatTimestamp = (timestamp: string | undefined): string => {
  const millis = Number(timestamp)
  return Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : (timestamp ?? '')
}

// Markdown emphasis breaks when it starts or ends with whitespace, so spaces stay outside.
const applyMarks = (text: string, marks: readonly AdfMark[]): string => {
  const [, lead = '', core = '', trail = ''] = /^(\s*)(.*?)(\s*)$/s.exec(text) ?? []
  if (core === '') return text

  const has = (type: string) => marks.some((mark) => mark.type === type)
  let out = core
  if (has('code')) {
    // Emphasis inside code is meaningless, so code wins over the other style marks.
    out = core.includes('`') ? `\`\` ${core} \`\`` : `\`${core}\``
  } else {
    if (has('strike')) out = `~~${out}~~`
    if (has('em')) out = `_${out}_`
    if (has('strong')) out = `**${out}**`
  }
  const link = marks.find((mark) => mark.type === 'link')
  const href = link === undefined ? undefined : attr(link, 'href')
  if (href !== undefined) out = `[${out}](${href})`
  return `${lead}${out}${trail}`
}
