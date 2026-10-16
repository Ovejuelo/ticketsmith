/**
 * Replaces sensitive values with stable placeholders such as [EMAIL_1] before text reaches an LLM.
 * The same value always gets the same placeholder within one call, so the model can still
 * correlate occurrences. Detectors favor precision: checksums and structure are validated to
 * avoid hiding ticket keys, dates, amounts or IDs the agent needs.
 */

export const ALL_MASK_KINDS = ['secret', 'email', 'curp', 'rfc', 'clabe', 'card', 'phone'] as const
export type MaskKind = (typeof ALL_MASK_KINDS)[number]

export type CustomMaskRule = { readonly label: string; readonly pattern: string }

export type MaskingOptions = {
  readonly detectors: readonly MaskKind[]
  readonly custom: readonly CustomMaskRule[]
  /** Show `[EMAIL_1]@company.com` (except public providers) so the account's company is known. */
  readonly keepEmailDomains: boolean
}

/** Issues placeholders. A fresh registry per call, or a session vault for cross-call consistency. */
export interface PlaceholderRegistry {
  placeholderFor(label: string, key: string, original: string): string
  /** Called with the exact text that replaced `original`, e.g. to re-mask it literally later. */
  remember?(original: string, replacement: string): void
}

export type MaskResult = {
  readonly text: string
  /** Replaced occurrences per detector (custom rules by their snake_case label). */
  readonly counts: Readonly<Record<string, number>>
}

type Detector = {
  readonly name: string
  readonly patterns: readonly RegExp[]
  readonly validate?: (match: string) => boolean
  /** How values are compared to reuse placeholders. */
  readonly normalize?: (match: string) => string
  /** Text that replaces the match; defaults to the placeholder itself. */
  readonly render?: (placeholder: string, match: string, options: MaskingOptions) => string
}

// Domains that say nothing about the customer; the whole address stays hidden.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'live.com.mx',
  'msn.com',
  'yahoo.com',
  'yahoo.com.mx',
  'ymail.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'prodigy.net.mx',
  'protonmail.com',
  'proton.me',
])

const digitsOf = (value: string): string => value.replace(/\D/g, '')

const SECRET_KEYS =
  'password|passwd|pwd|pass|api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key'

// SAT's public generic RFCs ("público en general" and foreign) identify nobody and are often the
// key fact in invoicing tickets, so they stay visible.
const GENERIC_RFCS = new Set(['XAXX010101000', 'XEXX010101000'])

const DETECTORS: Readonly<Record<MaskKind, Detector>> = {
  secret: {
    name: 'secret',
    patterns: [
      /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
      /(?<=\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{16,}/g,
      /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
      /\bAKIA[0-9A-Z]{16}\b/g,
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g,
      /\bATATT[A-Za-z0-9_=-]{20,}/g,
      /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
      new RegExp(`(?<=\\b(?:${SECRET_KEYS})\\s*[:=]\\s*["']?)[^\\s"',;]{4,}`, 'gi'),
      // Credentials embedded in URLs: scheme://user:password@host
      /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g,
    ],
  },
  email: {
    name: 'email',
    // Not followed by ":" or "/" and more text: that is a git remote (git@host:org/repo.git,
    // ssh://git@host/org/repo), not an address.
    patterns: [
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9-]|\.[A-Za-z0-9]|[:/][^\s])/g,
    ],
    normalize: (value) => value.toLowerCase(),
    render: (placeholder, match, options) => {
      const domain = match.slice(match.lastIndexOf('@') + 1).toLowerCase()
      return options.keepEmailDomains && !PUBLIC_EMAIL_DOMAINS.has(domain)
        ? `${placeholder}@${domain}`
        : placeholder
    },
  },
  curp: {
    name: 'curp',
    patterns: [
      /(?<![A-Za-z0-9])[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HM][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d(?![A-Za-z0-9])/gi,
    ],
    normalize: (value) => value.toUpperCase(),
  },
  rfc: {
    name: 'rfc',
    patterns: [/(?<![A-Za-z0-9Ññ&])[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}(?![A-Za-z0-9])/gi],
    validate: (value) => {
      if (GENERIC_RFCS.has(value.toUpperCase())) return false
      const date = /\d{6}/.exec(value)?.[0] ?? ''
      const month = Number(date.slice(2, 4))
      const day = Number(date.slice(4, 6))
      return month >= 1 && month <= 12 && day >= 1 && day <= 31
    },
    normalize: (value) => value.toUpperCase(),
  },
  clabe: {
    name: 'clabe',
    patterns: [/(?<![\d-])\d{18}(?![\d-])/g],
    validate: (value) => isValidClabe(value),
  },
  card: {
    name: 'card',
    patterns: [
      /(?<![\d-])\d{13,19}(?![\d-])/g,
      /(?<![\d-])\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?(?![\d-])/g,
      /(?<![\d-])\d{4}[ -]\d{6}[ -]\d{5}(?![\d-])/g,
    ],
    validate: (value) => {
      const digits = digitsOf(value)
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
    },
    normalize: digitsOf,
  },
  phone: {
    name: 'phone',
    patterns: [
      /(?<![\w+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?!\d)/g,
      // Local formats need separators; bare 10-digit numbers are usually IDs or folios.
      /(?<![\d(])\(?\d{2,3}\)?[\s.-]\d{3,4}[\s.-]\d{4}(?![\d-])/g,
    ],
    validate: (value) => {
      const count = digitsOf(value).length
      return value.trim().startsWith('+') ? count >= 10 && count <= 15 : count === 10
    },
    normalize: digitsOf,
  },
}

const PLACEHOLDER = /^\[[A-Z0-9_]+_\d+\]$/

export const isValidClabe = (value: string): boolean => {
  if (!/^\d{18}$/.test(value)) return false
  const weights = [3, 7, 1]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (Number(value[i]) * (weights[i % 3] ?? 1)) % 10
  return (10 - (sum % 10)) % 10 === Number(value[17])
}

export const passesLuhn = (digits: string): boolean => {
  if (/^(\d)\1+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

const snake = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'custom'

const customDetector = (rule: CustomMaskRule): Detector => ({
  name: snake(rule.label),
  patterns: [new RegExp(rule.pattern, 'g')],
})

/** Numbers placeholders per label within a single call. */
class CallRegistry implements PlaceholderRegistry {
  readonly #placeholders = new Map<string, string>()
  readonly #counters = new Map<string, number>()

  placeholderFor(label: string, key: string): string {
    const id = `${label}\u0000${key}`
    let placeholder = this.#placeholders.get(id)
    if (placeholder === undefined) {
      const next = (this.#counters.get(label) ?? 0) + 1
      this.#counters.set(label, next)
      placeholder = `[${label}_${next}]`
      this.#placeholders.set(id, placeholder)
    }
    return placeholder
  }
}

export const maskSensitiveData = (
  text: string,
  options: MaskingOptions,
  registry: PlaceholderRegistry = new CallRegistry(),
): MaskResult => {
  const detectors = [
    ...ALL_MASK_KINDS.filter((kind) => options.detectors.includes(kind)).map(
      (kind) => DETECTORS[kind],
    ),
    ...options.custom.map(customDetector),
  ]
  const counts: Record<string, number> = {}
  let masked = text

  for (const detector of detectors) {
    const label = detector.name.toUpperCase()
    for (const pattern of detector.patterns) {
      masked = masked.replace(pattern, (match) => {
        if (
          PLACEHOLDER.test(match) ||
          match.includes('[') ||
          !(detector.validate?.(match) ?? true)
        ) {
          return match
        }
        const placeholder = registry.placeholderFor(
          label,
          detector.normalize?.(match) ?? match,
          match,
        )
        const replacement = detector.render?.(placeholder, match, options) ?? placeholder
        registry.remember?.(match, replacement)
        counts[detector.name] = (counts[detector.name] ?? 0) + 1
        return replacement
      })
    }
  }
  return { text: masked, counts }
}
