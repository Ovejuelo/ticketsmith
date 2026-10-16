/** Applies `reveal` to every string of a JSON-like value (the agent's answer). */
export const revealDeep = <T>(value: T, reveal: (text: string) => string): T => {
  if (typeof value === 'string') return reveal(value) as T
  if (Array.isArray(value)) return value.map((item) => revealDeep(item, reveal)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revealDeep(item, reveal)]),
    ) as T
  }
  return value
}
