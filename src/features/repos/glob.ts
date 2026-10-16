/**
 * A minimal glob for file paths: `**` spans folders, `*` and `?` stay within one, `{a,b}` picks
 * one alternative. A pattern without "/" matches the file name anywhere (`*.sql`).
 */
export const globToRegExp = (glob: string): RegExp => {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? ''
    if (char === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '{') source += '(?:'
    else if (char === '}') source += ')'
    else if (char === ',') source += '|'
    else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(glob.includes('/') ? `^${source}$` : `(?:^|/)${source}$`)
}
