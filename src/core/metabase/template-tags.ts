import { createHash } from 'node:crypto'

export type TemplateTagType = 'date' | 'number' | 'text'

/** A Metabase native-query variable, as `template-tags` in a card's dataset_query. */
export type TemplateTag = {
  readonly id: string
  readonly name: string
  readonly 'display-name': string
  readonly type: TemplateTagType
  /** Variables inside an optional [[ … ]] clause may be left empty. */
  readonly required: boolean
}

const DATE_NAME =
  /(^|_)(date|fecha|day|dia|from|to|desde|hasta|start|end|since|until)($|_)|_at$|_on$/i
const NUMBER_NAME = /(^|_)(id|count|num|number|limit|amount|monto|year|month|anio|mes)$/i

/** Guesses a variable's type from its name: dates and numbers by convention, text otherwise. */
export const tagType = (name: string): TemplateTagType =>
  DATE_NAME.test(name) ? 'date' : NUMBER_NAME.test(name) ? 'number' : 'text'

const displayName = (name: string): string => {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The template tags of a native query: every `{{name}}`, in order of first use. Snippets
 * (`{{snippet: …}}`) and saved-question references (`{{#12}}`) are not variables and are skipped.
 * Ids are derived from the name so the same query always produces the same card.
 */
export const templateTags = (sql: string): Readonly<Record<string, TemplateTag>> => {
  const tags: Record<string, TemplateTag> = {}
  const optional = new Set<string>()
  for (const clause of sql.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    for (const variable of (clause[1] ?? '').matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)) {
      optional.add(variable[1] ?? '')
    }
  }
  for (const match of sql.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)) {
    const name = match[1] ?? ''
    if (name in tags) continue
    const digest = createHash('sha256').update(name).digest('hex')
    tags[name] = {
      id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
      name,
      'display-name': displayName(name),
      type: tagType(name),
      required: !optional.has(name),
    }
  }
  return tags
}
