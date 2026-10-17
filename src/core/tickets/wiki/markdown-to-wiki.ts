/**
 * Markdown (what Ticketsmith writes, e.g. jira_comment.md) to JIRA wiki markup, for Data Center
 * comments. Pure and total: headings, emphasis, inline code, fenced code, quotes, lists, links,
 * tables and rules; anything else passes through as text.
 */
export const markdownToWiki = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fence: string | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (fence !== null) {
      if (line.trim().startsWith(fence)) {
        out.push('{code}')
        fence = null
      } else {
        out.push(line)
      }
      continue
    }
    const opening = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/.exec(line)
    if (opening !== null) {
      fence = opening[1] ?? '```'
      out.push(opening[2] ? `{code:${opening[2]}}` : '{code}')
      continue
    }

    // A table: header row, then the |---| separator.
    if (isTableRow(line) && isSeparator(lines[index + 1] ?? '')) {
      out.push(`||${cells(line).map(inline).join('||')}||`)
      index++
      while (isTableRow(lines[index + 1] ?? '')) {
        index++
        out.push(
          `|${cells(lines[index] ?? '')
            .map(inline)
            .join('|')}|`,
        )
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      out.push(`h${heading[1]?.length}. ${inline(heading[2] ?? '')}`)
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      out.push(`bq. ${inline(quote[1] ?? '')}`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('----')
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item !== null) {
      const depth = Math.floor((item[1] ?? '').replace(/\t/g, '  ').length / 2) + 1
      const marker = /\d/.test(item[2] ?? '') ? '#' : '*'
      out.push(`${marker.repeat(depth)} ${inline(item[3] ?? '')}`)
      continue
    }
    out.push(inline(line))
  }
  if (fence !== null) out.push('{code}')
  return out.join('\n').trim()
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isSeparator = (line: string): boolean => /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(line)
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

/** Inline markup, leaving `code` spans untouched inside. */
const inline = (text: string): string =>
  text
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2
        ? `{{${part.slice(1, -1)}}}`
        : inlineText(part),
    )
    .join('')

// Bold first goes through a placeholder so the italic rule does not see its asterisks.
const BOLD = '\u0000'
const inlineText = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '!$2!')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '[$1|$2]')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '[$1]')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, `${BOLD}$2${BOLD}`)
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1_$2_')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '-$1-')
    .replaceAll(BOLD, '*')
