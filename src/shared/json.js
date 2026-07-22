export function parseJsonLike(raw) {
  return JSON.parse(removeJsonTrailingCommas(stripJsonComments(raw)))
}

export function stripJsonComments(raw) {
  let result = ""
  let inString = false
  let escaping = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    const next = raw[index + 1]

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      result += char
      if (escaping) {
        escaping = false
      } else if (char === "\\") {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    result += char
  }

  return result
}

export function removeJsonTrailingCommas(raw) {
  let result = ""
  let inString = false
  let escaping = false

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]

    if (inString) {
      result += char
      if (escaping) {
        escaping = false
      } else if (char === "\\") {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === ",") {
      let nextIndex = index + 1
      while (nextIndex < raw.length && /\s/.test(raw[nextIndex])) nextIndex += 1
      if (raw[nextIndex] === "}" || raw[nextIndex] === "]") continue
    }

    result += char
  }

  return result
}
