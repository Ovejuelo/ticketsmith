import type { Ticket } from './ticket.schema.ts'

/** Renders a normalized ticket as a self-contained Markdown document for people and LLMs. */
export const renderTicketMarkdown = (ticket: Ticket): string => {
  const metadata: [string, string][] = [
    ['Type', ticket.type],
    ['Status', ticket.status],
    ['Priority', ticket.priority ?? 'None'],
    ['Assignee', ticket.assignee?.displayName ?? 'Unassigned'],
    ['Reporter', ticket.reporter?.displayName ?? 'Unknown'],
    ['Created', ticket.created],
    ['Updated', ticket.updated],
    ['URL', ticket.url],
  ]
  if (ticket.labels.length > 0) metadata.push(['Labels', ticket.labels.join(', ')])
  if (ticket.components.length > 0) metadata.push(['Components', ticket.components.join(', ')])
  for (const [name, value] of Object.entries(ticket.customFields)) metadata.push([name, value])

  const sections = [
    `# ${ticket.key}: ${ticket.summary}`,
    metadata.map(([name, value]) => `- **${name}:** ${value}`).join('\n'),
    `## Description\n\n${ticket.description || '_No description._'}`,
  ]

  if (ticket.links.length > 0) {
    sections.push(
      `## Links\n\n${ticket.links.map((link) => `- ${link.type} ${link.key}: ${link.summary}`).join('\n')}`,
    )
  }
  if (ticket.attachments.length > 0) {
    sections.push(
      `## Attachments\n\n${ticket.attachments
        .map((file) => `- ${file.filename} (${file.mimeType}, ${formatBytes(file.size)})`)
        .join('\n')}`,
    )
  }

  const comments = ticket.comments.map(
    (comment) =>
      `### ${comment.author?.displayName ?? 'Unknown'} · ${comment.created}\n\n${comment.body || '_Empty comment._'}`,
  )
  sections.push(
    `## Comments (${ticket.comments.length})${comments.length > 0 ? `\n\n${comments.join('\n\n')}` : ''}`,
  )

  return `${sections.join('\n\n')}\n`
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
