import { MODEL_CONTEXT_WINDOWS, resolveFallbackContextWindow } from "./models.js"

const DEFAULT_CONTEXT_WINDOW = 200000

export function resolveContextWindow(model, explicitValue) {
  const explicit = toPositiveNumber(explicitValue)
  if (explicit) return explicit

  const candidates = getLookupCandidates(model)
  for (const candidate of candidates) {
    const exact = MODEL_CONTEXT_WINDOWS[candidate]
    if (exact) return exact
  }

  const fallback = resolveFallbackContextWindow(model)
  if (fallback) return fallback

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
