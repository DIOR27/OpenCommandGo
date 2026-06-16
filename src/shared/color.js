// ANSI color helpers — zero dependencies, NO_COLOR aware

const noColor = process.env.NO_COLOR !== undefined

function ansi(code, text) {
  if (noColor || !text) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

export function green(text)  { return ansi(32, text) }
export function red(text)    { return ansi(31, text) }
export function yellow(text) { return ansi(33, text) }
export function cyan(text)   { return ansi(36, text) }
export function bold(text)   { return ansi(1, text) }
export function dim(text)    { return ansi(2, text) }
export function gray(text)   { return ansi(90, text) }

// Auto-colorize common status words
const STATUS_COLORS = [
  { pattern: /^(ok|up|yes|active|enabled|habilitado)$/i,    color: green },
  { pattern: /^(down|missing|no|inactive|fail|caído|faltante|disabled|deshabilitado)$/i, color: red },
  { pattern: /^(warning|timeout|degraded|catalog_only)$/i,  color: yellow },
]

export function colorizeStatus(text) {
  if (noColor || !text) return text
  for (const { pattern, color } of STATUS_COLORS) {
    if (pattern.test(text)) return color(text)
  }
  return text
}
