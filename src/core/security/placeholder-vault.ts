import { err, ok, type Result } from '../kernel/index.ts'
import {
  type MaskingOptions,
  type MaskResult,
  maskSensitiveData,
  type PlaceholderRegistry,
} from './mask-sensitive-data.ts'

// `[EMAIL_1]` optionally followed by the visible domain we render for corporate emails.
const PLACEHOLDER_REFERENCE = /\[([A-Z][A-Z0-9_]*_\d+)\](?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?/g
const MIN_LITERAL_LENGTH = 4

/**
 * Session-scoped pseudonymization: placeholders stay consistent across tool calls, and tools can
 * turn placeholders in their inputs back into real values (e.g. to query JIRA or the DB) without
 * the model ever seeing them. Lives only in memory; never persist or log it.
 */
export class PlaceholderVault implements PlaceholderRegistry {
  readonly #placeholders = new Map<string, string>()
  readonly #originals = new Map<string, string>()
  readonly #replacements = new Map<string, string>()
  readonly #counters = new Map<string, number>()

  placeholderFor(label: string, key: string, original: string): string {
    const id = `${label}\u0000${key}`
    let placeholder = this.#placeholders.get(id)
    if (placeholder === undefined) {
      const next = (this.#counters.get(label) ?? 0) + 1
      this.#counters.set(label, next)
      placeholder = `[${label}_${next}]`
      this.#placeholders.set(id, placeholder)
      this.#originals.set(placeholder, original)
    }
    return placeholder
  }

  remember(original: string, replacement: string): void {
    if (original.length >= MIN_LITERAL_LENGTH) this.#replacements.set(original, replacement)
  }

  /**
   * Masks known values literally first (they may appear where no detector matches, such as an
   * API error echoing a resolved query), then runs the detectors.
   */
  mask(text: string, options: MaskingOptions): MaskResult {
    let masked = text
    const known: Record<string, number> = {}
    const longestFirst = [...this.#replacements].sort(([a], [b]) => b.length - a.length)
    for (const [original, replacement] of longestFirst) {
      const parts = masked.split(original)
      if (parts.length > 1) {
        masked = parts.join(replacement)
        const kind = /^\[([A-Z0-9_]+)_\d+\]/.exec(replacement)?.[1]?.toLowerCase() ?? 'known'
        known[kind] = (known[kind] ?? 0) + parts.length - 1
      }
    }

    const detected = maskSensitiveData(masked, options, this)
    const counts: Record<string, number> = { ...detected.counts }
    for (const [kind, count] of Object.entries(known)) counts[kind] = (counts[kind] ?? 0) + count
    return { text: detected.text, counts }
  }

  /** Replaces placeholders with real values; fails listing any placeholder this vault never issued. */
  resolve(text: string): Result<string, readonly string[]> {
    const unknown = new Set<string>()
    const resolved = text.replace(PLACEHOLDER_REFERENCE, (match, id: string) => {
      const original = this.#originals.get(`[${id}]`)
      if (original === undefined) {
        unknown.add(`[${id}]`)
        return match
      }
      return original
    })
    return unknown.size === 0 ? ok(resolved) : err([...unknown])
  }
}
