import { resolveContextWindow } from "./context-windows.js"

export function extractOpenRouterModelRows(data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  return rows.filter(row => row && typeof row === "object")
}

export function normalizeOpenRouterCatalogRows(rawModels) {
  const seen = new Set()
  const result = []

  for (const raw of rawModels) {
    const id = firstString(raw.id, raw.slug, raw.canonical_slug)
    if (!id || seen.has(id) || !isFreeOpenRouterModel(raw, id)) continue
    seen.add(id)

    const inputModalities = normalizeStringArray(raw?.architecture?.input_modalities)
    const outputModalities = normalizeStringArray(raw?.architecture?.output_modalities)
    const reasoning = normalizeReasoning(raw)

    result.push({
      id,
      name: firstString(raw.name, raw.display_name) || id,
      tags: buildOpenRouterTags(raw, inputModalities, outputModalities, reasoning),
      context_length: resolveContextWindow(id, firstNumber(raw.top_provider?.context_length, raw.context_length)),
      pricing: raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {},
      supported_parameters: normalizeStringArray(raw.supported_parameters),
      catalog_capabilities: {
        vision: capabilityFromModalities(inputModalities, "image", "catalog.architecture.input_modalities"),
        pdf: capabilityFromModalities(inputModalities, "file", "catalog.architecture.input_modalities"),
        audio: capabilityFromModalities(inputModalities, "audio", "catalog.architecture.input_modalities"),
        video: capabilityFromModalities(inputModalities, "video", "catalog.architecture.input_modalities"),
        reasoning: {
          supported: reasoning.supported,
          source: reasoning.source,
          supported_efforts: reasoning.supported_efforts,
        },
      },
    })
  }

  return result
}

export function isFreeOpenRouterModel(raw, modelId = "") {
  const prompt = normalizePrice(raw?.pricing?.prompt)
  const completion = normalizePrice(raw?.pricing?.completion)
  if (prompt === 0 && completion === 0) return true
  return String(modelId || raw?.id || "").toLowerCase().includes(":free")
}

function normalizeReasoning(raw) {
  const supportedParameters = normalizeStringArray(raw.supported_parameters)
  const reasoningObject = raw?.reasoning && typeof raw.reasoning === "object" ? raw.reasoning : null
  const hasReasoningObject = Boolean(reasoningObject)
  const supported = hasReasoningObject || supportedParameters.includes("reasoning") || supportedParameters.includes("reasoning_effort")
  return {
    supported,
    source: supported
      ? (hasReasoningObject ? "catalog.reasoning" : "catalog.supported_parameters")
      : null,
    supported_efforts: normalizeStringArray(reasoningObject?.supported_efforts),
  }
}

function capabilityFromModalities(modalities, needle, source) {
  return {
    supported: modalities.includes(needle),
    source: modalities.includes(needle) ? source : null,
  }
}

function buildOpenRouterTags(raw, inputModalities, outputModalities, reasoning) {
  const tags = new Set(normalizeStringArray(raw.tags))
  for (const modality of inputModalities) tags.add(modality)
  for (const modality of outputModalities) tags.add(`out:${modality}`)
  if (reasoning.supported) tags.add("reasoning")
  if (isFreeOpenRouterModel(raw, raw?.id)) tags.add("free")
  return Array.from(tags)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
      .map(value => typeof value === "string" ? value.trim().toLowerCase() : "")
      .filter(Boolean)
    : []
}

function normalizePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
