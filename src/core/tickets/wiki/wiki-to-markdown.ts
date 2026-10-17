/**
 * JIRA wiki markup (Data Center descriptions and comments, API v2) to Markdown. Pure and total:
 * markup it does not know stays as plain text, and it never throws. Covers headings, emphasis,
 * monospace, code and noformat blocks, quotes, panels, lists, links, mentions, tables, images
 * (as `[attachment: name]`), rules and line breaks.
 */
export const wikiToMarkdown = (wiki: string): string => {
  const lines = wiki.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let block: { readonly kind: 'code' | 'quote'; readonly lines: string[] } | null = null
  let table: string[][] = []
  let tableHasHeader = false

  const flushTable = () => {
    if (table.length === 0) return
    const width = Math.max(...table.map((row) => row.length))
    const row = (cells: readonly string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
    const [first, ...rest] = table
    out.push(row(tableHasHeader ? (first ?? []) : Array.from({ length: width }, () => '')))
    out.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
    for (const cells of tableHasHeader ? rest : table) out.push(row(cells))
    table = []
    tableHasHeader = false
  }

  for (const line of lines) {
    if (block?.kind === 'code') {
      const end = /\{(code|noformat)\}/.exec(line)
      if (end === null) {
        block.lines.push(line)
        continue
      }
      block.lines.push(line.slice(0, end.index))
      out.push(...trimBlock(block.lines), '```')
      block = null
      const after = line.slice(end.index + end[0].length).trim()
      if (after !== '') out.push(inline(after))
      continue
    }
    if (block?.kind === 'quote') {
      if (/^\s*\{quote\}\s*$/.test(line)) {
        out.push(...trimBlock(block.lines).map((quoted) => (quoted === '' ? '>' : `> ${quoted}`)))
        block = null
      } else {
        block.lines.push(inline(line))
      }
      continue
    }

    const codeStart = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/.exec(line)
    if (codeStart !== null) {
      flushTable()
      const language = codeLanguage(codeStart[1] === 'code' ? (codeStart[2] ?? '') : '')
      const rest = codeStart[3] ?? ''
      const sameLineEnd = /\{(code|noformat)\}/.exec(rest)
      if (sameLineEnd !== null) {
        out.push(`\`\`\`${language}`, rest.slice(0, sameLineEnd.index), '```')
        continue
      }
      out.push(`\`\`\`${language}`)
      block = { kind: 'code', lines: rest === '' ? [] : [rest] }
      continue
    }
    if (/^\s*\{quote\}\s*$/.test(line)) {
      flushTable()
      block = { kind: 'quote', lines: [] }
      continue
    }

    const cells = tableRow(line)
    if (cells !== null) {
      if (table.length === 0) tableHasHeader = cells.header
      table.push(cells.cells.map(inline))
      continue
    }
    flushTable()
    out.push(blockLine(line))
  }
  if (block !== null) {
    // Unterminated block: keep its text rather than lose it.
    if (block.kind === 'code') out.push(...block.lines, '```')
    else out.push(...block.lines.map((quoted) => `> ${quoted}`))
  }
  flushTable()
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const trimBlock = (lines: readonly string[]): string[] => {
  const copy = [...lines]
  while (copy[0]?.trim() === '') copy.shift()
  while (copy.at(-1)?.trim() === '') copy.pop()
  return copy
}

const codeLanguage = (options: string): string => {
  const first = options.split('|')[0]?.trim() ?? ''
  return /^[A-Za-z0-9+#-]+$/.test(first) && !first.includes('=') ? first.toLowerCase() : ''
}

/** `||a||b||` (header) or `|a|b|`; null when the line is not a table row. */
const tableRow = (
  line: string,
): { readonly header: boolean; readonly cells: readonly string[] } | null => {
  const trimmed = line.trim()
  if (trimmed.startsWith('||')) {
    return {
      header: true,
      cells: splitCells(trimmed.replace(/^\|\|/, '').replace(/\|\|$/, ''), '||'),
    }
  }
  if (trimmed.startsWith('|') && trimmed.length > 1) {
    return { header: false, cells: splitCells(trimmed.replace(/^\|/, '').replace(/\|$/, ''), '|') }
  }
  return null
}

/** Splits on the separator, but not inside [links|…] or {macros}. */
const splitCells = (row: string, separator: '|' | '||'): string[] => {
  const cells: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < row.length; i++) {
    const char = row[i]
    if (char === '[' || char === '{') depth++
    if ((char === ']' || char === '}') && depth > 0) depth--
    if (depth === 0 && row.startsWith(separator, i)) {
      cells.push(current.trim())
      current = ''
      i += separator.length - 1
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

const blockLine = (line: string): string => {
  const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line)
  if (heading !== null) return `${'#'.repeat(Number(heading[1]))} ${inline(heading[2] ?? '')}`
  const quote = /^\s*bq\.\s+(.*)$/.exec(line)
  if (quote !== null) return `> ${inline(quote[1] ?? '')}`
  if (/^\s*-{4,}\s*$/.test(line)) return '---'
  const list = /^\s*([*#-]+)\s+(.*)$/.exec(line)
  if (list !== null && isListMarker(list[1] ?? '')) {
    const markers = list[1] ?? ''
    const indent = '  '.repeat(markers.length - 1)
    const bullet = markers.endsWith('#') ? '1.' : '-'
    return `${indent}${bullet} ${inline(list[2] ?? '')}`
  }
  const panel = /^\s*\{panel(?::([^}]*))?\}\s*$/.exec(line)
  if (panel !== null) {
    const title = /(?:^|\|)title=([^|]*)/.exec(panel[1] ?? '')?.[1]
    return title === undefined ? '' : `**${title.trim()}**`
  }
  return inline(line)
}

// "-" alone is a list only as a single marker ("- item"); "*#" mixes are nested lists.
const isListMarker = (markers: string): boolean => markers === '-' || /^[*#]+$/.test(markers)

/** Inline markup, leaving {{monospace}} spans untouched inside. */
const inline = (text: string): string => {
  const parts = text.split(/(\{\{.*?\}\})/)
  return parts
    .map((part) =>
      part.startsWith('{{') && part.endsWith('}}') && part.length > 4
        ? `\`${part.slice(2, -2)}\``
        : inlineText(part),
    )
    .join('')
}

const inlineText = (text: string): string =>
  text
    .replace(/\{color(?::[^}]*)?\}/g, '')
    .replace(/\{panel(?::[^}]*)?\}/g, '')
    .replace(/!([^!\s|][^!|]*?)(?:\|[^!]*)?!/g, (_, name: string) => `[attachment: ${name.trim()}]`)
    .replace(/\[~([^\]]+)\]/g, '@$1')
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, (_, label: string, url: string) =>
      isUrl(url) ? `[${label.trim()}](${url.trim()})` : `${label.trim()} (${url.trim()})`,
    )
    .replace(/\[([^\]|\s]+)\]/g, (whole, url: string) => (isUrl(url) ? `<${url}>` : whole))
    .replace(/(^|[^\w*])\*(\S(?:.*?\S)?)\*(?=[^\w*]|$)/g, '$1**$2**')
    .replace(/(^|[^\w])_(\S(?:.*?\S)?)_(?=[^\w]|$)/g, '$1*$2*')
    .replace(/(^|\s)-(\S(?:.*?\S)?)-(?=\s|$|[.,;:!?])/g, '$1~~$2~~')
    .replace(/(^|\s)\+(\S(?:.*?\S)?)\+(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/(^|\s)\?\?(\S(?:.*?\S)?)\?\?(?=\s|$|[.,;:!?])/g, '$1*$2*')
    .replace(/ ?\\\\ ?/g, '  \n')

const isUrl = (value: string): boolean => /^(https?:\/\/|mailto:)/i.test(value.trim())
