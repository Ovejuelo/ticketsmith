import { createRequire } from 'node:module'

// node-sql-parser is CommonJS without named ESM exports; its types do declare `Parser`.
const { Parser } = createRequire(import.meta.url)(
  'node-sql-parser',
) as typeof import('node-sql-parser')
const parser = new Parser()

/** The SQL engines the guards understand. Each has its own parser mode and text rules. */
export type Dialect = 'mysql' | 'postgres'

export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
}

const options = (dialect: Dialect) => ({ database: DIALECT_LABEL[dialect] })

type Ast = Parameters<typeof parser.sqlify>[0]

/** Parses with the dialect's grammar; throws like node-sql-parser does. */
export const astify = (sql: string, dialect: Dialect): unknown =>
  parser.astify(sql, options(dialect))

export const sqlify = (ast: unknown, dialect: Dialect): string =>
  parser.sqlify(ast as Ast, options(dialect)).trim()

export const exprToSql = (expr: unknown, dialect: Dialect): string =>
  parser.exprToSQL(expr as Parameters<typeof parser.exprToSQL>[0], options(dialect))

export const field = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined

/**
 * A column or identifier name as the database sees it. MySQL's tree holds plain strings;
 * PostgreSQL's holds `{ type, value }` (or `{ expr: { type, value } }`), where an unquoted
 * (`default`) name is folded to lower case, as PostgreSQL itself does.
 */
export const identifierName = (node: unknown): string => {
  if (typeof node === 'string') return node
  const inner = field(node, 'expr') ?? node
  const value = field(inner, 'value')
  if (typeof value !== 'string') return String(value)
  return field(inner, 'type') === 'default' ? value.toLowerCase() : value
}

/** A dollar-quoted PostgreSQL string ($$…$$ or $tag$…$tag$), which the parser reads as a `var`. */
export const isDollarString = (node: unknown): boolean => {
  const prefix = field(node, 'prefix')
  return (
    field(node, 'type') === 'var' &&
    typeof prefix === 'string' &&
    /^\$[A-Za-z_]?[A-Za-z0-9_]*\$$/.test(prefix) &&
    field(node, 'suffix') === prefix
  )
}

const NAME_KEYS = new Set(['table', 'db', 'as'])

/**
 * node-sql-parser quotes every table, schema and alias name it regenerates for PostgreSQL, which
 * would make `FROM Users` case-sensitive (`"Users"`). This folds the names that were not quoted
 * in the text to lower case, as PostgreSQL does, so the regenerated SQL means the same. A name
 * written both quoted and unquoted with different case is ambiguous and reported.
 */
export const foldPostgresNames = (
  ast: unknown,
  quoted: ReadonlySet<string>,
  bare: ReadonlySet<string>,
): string | null => {
  const fold = (name: string): string | { readonly problem: string } => {
    if (!quoted.has(name)) return name.toLowerCase()
    if (bare.has(name) && name !== name.toLowerCase()) {
      return { problem: `"${name}" is written both quoted and unquoted; quote it every time.` }
    }
    return name
  }
  const walk = (node: unknown): string | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item)
        if (found !== null) return found
      }
      return null
    }
    if (node === null || typeof node !== 'object') return null
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (NAME_KEYS.has(key) && typeof value === 'string') {
        const folded = fold(value)
        if (typeof folded !== 'string') return folded.problem
        record[key] = folded
        continue
      }
      // A CTE's name: { type: 'default', value }.
      if (
        key === 'name' &&
        field(value, 'type') === 'default' &&
        field(node, 'stmt') !== undefined
      ) {
        const folded = fold(String(field(value, 'value')))
        if (typeof folded !== 'string') return folded.problem
        ;(value as Record<string, unknown>)['value'] = folded
        continue
      }
      const found = walk(value)
      if (found !== null) return found
    }
    return null
  }
  return walk(ast)
}
