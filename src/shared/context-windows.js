const KNOWN_MODEL_CONTEXT_WINDOWS = {
  "moonshotai/kimi-k2.6": 262144,
  "moonshotai/kimi-k2.5": 262144,
  "qwen/qwen3.7-max": 262144,
  "qwen/qwen3.7-plus": 262144,
  "qwen/qwen3.7-max-free": 262144,
  "minimaxai/minimax-m3": 200000,
  "minimaxai/minimax-m2.7": 204800,
  "minimaxai/minimax-m2.5": 196000,
  "deepseek/deepseek-v4-pro": 200000,
  "deepseek/deepseek-v4-flash": 200000,
  "zai-org/glm-5.1": 200000,
  "zai-org/glm-5": 200000,
}

const PREFIX_CONTEXT_WINDOWS = {
  "moonshotai/kimi-k2": 262144,
  "qwen/qwen3.7": 262144,
  "minimaxai/minimax-m2.7": 204800,
  "minimaxai/minimax-m2.5": 196000,
  "minimaxai/minimax-m3": 200000,
  "deepseek/deepseek-v4": 200000,
  "zai-org/glm-5": 200000,
}

const DEFAULT_CONTEXT_WINDOW = 200000

export function resolveContextWindow(model, explicitValue) {
  const explicit = toPositiveNumber(explicitValue)
  if (explicit) return explicit

  const candidates = getLookupCandidates(model)
  for (const candidate of candidates) {
    const exact = KNOWN_MODEL_CONTEXT_WINDOWS[candidate]
    if (exact) return exact
  }

  const prefixes = Object.keys(PREFIX_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    for (const prefix of prefixes) {
      if (candidate.startsWith(prefix)) return PREFIX_CONTEXT_WINDOWS[prefix]
    }
  }

  return DEFAULT_CONTEXT_WINDOW
}

function getLookupCandidates(model) {
  const normalized = String(model || "").trim().toLowerCase()
  if (!normalized) return []

  const result = [normalized]
  const slashIndex = normalized.lastIndexOf("/")
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    result.push(normalized.slice(slashIndex + 1))
  }
  return Array.from(new Set(result))
}

function toPositiveNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}
