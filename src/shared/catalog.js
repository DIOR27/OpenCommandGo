import { MODELS as FALLBACK_MODELS } from "./models.js"

export function isCommandCodeClaudeModel(model) {
  const raw = String(model || "").trim().toLowerCase()
  return raw.includes("claude")
}

export function isCommandCodeOpenAIModel(model) {
  const normalized = comparableCommandCodeModel(model)
  const leaf = normalized.split("/").pop() ?? normalized
  return (
    leaf.startsWith("gpt-")
    || leaf.startsWith("o1")
    || leaf.startsWith("o3")
    || leaf.startsWith("o4")
    || leaf.includes("codex")
  )
}

export function isAlphaCandidateModel(model) {
  return !isCommandCodeClaudeModel(model) && !isCommandCodeOpenAIModel(model)
}

export function comparableCommandCodeModel(model) {
  return String(model || "").trim().toLowerCase().replace(/[._]/g, "-")
}

export function extractModelRows(data) {
  if (Array.isArray(data)) return data.filter(isRecord)
  if (!isRecord(data)) return []
  const rows = data.data ?? data.models
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

export function fallbackCatalog() {
  return FALLBACK_MODELS.map(([id, name]) => ({
    id,
    name,
    context_length: 200000,
  }))
}

export function normalizeCatalogRows(rawModels) {
  const seen = new Set()
  const result = []
  for (const raw of rawModels) {
    const id = firstString(raw.id, raw.model, raw.name)
    if (!id || seen.has(id) || !isAlphaCandidateModel(id)) continue
    seen.add(id)
    result.push({
      id,
      name: firstString(raw.display_name, raw.displayName, raw.label, raw.name) || id,
      context_length: firstNumber(
        raw.context_length,
        raw.contextLength,
        raw.context_window,
        raw.max_context_length,
      ) || 200000,
    })
  }
  return result
}

export function deriveCatalogFromCompatibility(compatibilityMatrix) {
  const entries = Object.entries(compatibilityMatrix?.models || {})
    .filter(([, info]) => info && typeof info === "object" && info.status !== "broken")
    .map(([id, info]) => ({
      id,
      name: info.name || id,
      context_length: info.context_length || 200000,
    }))
  return entries.length > 0 ? entries : fallbackCatalog()
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
