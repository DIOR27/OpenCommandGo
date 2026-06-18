import { MODELS as FALLBACK_MODELS } from "./models.js"
import { resolveContextWindow } from "./context-windows.js"

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
    context_length: resolveContextWindow(id),
    tags: [],
    catalog_capabilities: {
      vision: {
        supported: null,
        source: null,
      },
      pdf: {
        supported: null,
        source: null,
      },
      audio: {
        supported: null,
        source: null,
      },
      video: {
        supported: null,
        source: null,
      },
      reasoning: {
        supported: null,
        source: null,
      },
    },
  }))
}

export function normalizeCatalogRows(rawModels) {
  const seen = new Set()
  const result = []
  for (const raw of rawModels) {
    const id = firstString(raw.id, raw.model, raw.name)
    if (!id || seen.has(id) || !isAlphaCandidateModel(id)) continue
    seen.add(id)
    const inferredCapabilities = inferCatalogCapabilities(raw, id)
    result.push({
      id,
      name: firstString(raw.display_name, raw.displayName, raw.label, raw.name) || id,
      tags: normalizeStringArray(firstArray(raw.tags) || []),
      context_length: resolveContextWindow(id, firstNumber(
        raw.context_length,
        raw.contextLength,
        raw.context_window,
        raw.contextWindow,
        raw.max_context_length,
      )),
      catalog_capabilities: inferredCapabilities,
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
      context_length: resolveContextWindow(id, info.context_length),
      catalog_capabilities: {
        vision: normalizeStoredVisionCapability(info),
        pdf: normalizeStoredPdfCapability(info),
        audio: normalizeStoredGenericCapability(info, "audio"),
        video: normalizeStoredGenericCapability(info, "video"),
        reasoning: normalizeStoredGenericCapability(info, "reasoning"),
      },
    }))
  return entries.length > 0 ? entries : fallbackCatalog()
}

function inferCatalogCapabilities(raw, modelId = "") {
  const vision = inferCatalogVisionCapability(raw)
  const pdf = inferCatalogPdfCapability(raw)
  const audio = inferCatalogMediaCapability(raw, "audio")
  const video = inferCatalogMediaCapability(raw, "video")
  const reasoning = inferCatalogReasoningCapability(raw)
  return applyKnownCapabilityHints(modelId, { vision, pdf, audio, video, reasoning })
}

function inferCatalogVisionCapability(raw) {
  const directVision = firstBoolean(raw.supports_vision, raw.supportsVision)
  if (directVision !== null) {
    return {
      supported: directVision,
      source: "catalog.supports_vision",
    }
  }

  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : null
  const capabilitiesVision = firstBoolean(capabilities?.vision)
  if (capabilitiesVision !== null) {
    return {
      supported: capabilitiesVision,
      source: "catalog.capabilities.vision",
    }
  }

  const inputModalities = firstArray(
    raw.input_modalities,
    raw.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
    raw.modalities,
  )
  const normalizedModalities = normalizeStringArray(inputModalities)
  if (normalizedModalities.length > 0) {
    const supportsVision = normalizedModalities.some(value =>
      ["image", "vision", "multimodal"].includes(value),
    )
    return {
      supported: supportsVision,
      source: "catalog.modalities",
    }
  }

  const tags = normalizeStringArray(raw.tags)
  if (tags.length > 0 && tags.includes("vision")) {
    return {
      supported: true,
      source: "catalog.tags",
    }
  }

  return {
    supported: null,
    source: null,
  }
}

function inferCatalogPdfCapability(raw) {
  const directPdf = firstBoolean(
    raw.supports_pdf,
    raw.supportsPdf,
    raw.supports_documents,
    raw.supportsDocuments,
  )
  if (directPdf !== null) {
    return {
      supported: directPdf,
      source: "catalog.supports_pdf",
    }
  }

  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : null
  const capabilityPdf = firstBoolean(
    capabilities?.pdf,
    capabilities?.document,
    capabilities?.documents,
  )
  if (capabilityPdf !== null) {
    return {
      supported: capabilityPdf,
      source: "catalog.capabilities.pdf",
    }
  }

  const inputModalities = firstArray(
    raw.input_modalities,
    raw.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
    raw.modalities,
  )
  const normalizedModalities = normalizeStringArray(inputModalities)
  if (normalizedModalities.length > 0) {
    const supportsPdf = normalizedModalities.some(value =>
      ["pdf", "document", "documents", "file", "files"].includes(value),
    )
    return {
      supported: supportsPdf,
      source: "catalog.modalities",
    }
  }

  const tags = normalizeStringArray(raw.tags)
  if (tags.length > 0) {
    if (tags.includes("pdf") || tags.includes("document") || tags.includes("documents")) {
      return {
        supported: true,
        source: "catalog.tags",
      }
    }
  }

  return {
    supported: null,
    source: null,
  }
}

function inferCatalogMediaCapability(raw, kind) {
  const supportKeys = kind === "audio"
    ? [raw.supports_audio, raw.supportsAudio]
    : [raw.supports_video, raw.supportsVideo]
  const direct = firstBoolean(...supportKeys)
  if (direct !== null) {
    return {
      supported: direct,
      source: `catalog.supports_${kind}`,
    }
  }

  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : null
  const fromCapabilities = firstBoolean(capabilities?.[kind])
  if (fromCapabilities !== null) {
    return {
      supported: fromCapabilities,
      source: `catalog.capabilities.${kind}`,
    }
  }

  const inputModalities = firstArray(
    raw.input_modalities,
    raw.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
    raw.modalities,
  )
  const normalizedModalities = normalizeStringArray(inputModalities)
  if (normalizedModalities.length > 0) {
    return {
      supported: normalizedModalities.includes(kind),
      source: "catalog.modalities",
    }
  }

  const tags = normalizeStringArray(raw.tags)
  if (tags.includes(kind)) {
    return {
      supported: true,
      source: "catalog.tags",
    }
  }

  return {
    supported: null,
    source: null,
  }
}

function inferCatalogReasoningCapability(raw) {
  const directReasoning = firstBoolean(
    raw.supports_reasoning,
    raw.supportsReasoning,
    raw.reasoning,
    raw.thinking,
  )
  if (directReasoning !== null) {
    return {
      supported: directReasoning,
      source: "catalog.supports_reasoning",
    }
  }

  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : null
  const fromCapabilities = firstBoolean(
    capabilities?.reasoning,
    capabilities?.thinking,
  )
  if (fromCapabilities !== null) {
    return {
      supported: fromCapabilities,
      source: "catalog.capabilities.reasoning",
    }
  }

  const tags = normalizeStringArray(raw.tags)
  if (tags.includes("reasoning") || tags.includes("thinking")) {
    return {
      supported: true,
      source: "catalog.tags",
    }
  }

  return {
    supported: null,
    source: null,
  }
}

function applyKnownCapabilityHints(modelId, capabilities) {
  const normalized = comparableCommandCodeModel(modelId)
  const next = {
    vision: { ...(capabilities?.vision || { supported: null, source: null }) },
    pdf: { ...(capabilities?.pdf || { supported: null, source: null }) },
    audio: { ...(capabilities?.audio || { supported: null, source: null }) },
    video: { ...(capabilities?.video || { supported: null, source: null }) },
    reasoning: { ...(capabilities?.reasoning || { supported: null, source: null }) },
  }

  if (normalized === "moonshotai/kimi-k2-5" || normalized === "moonshotai/kimi-k2-6") {
    if (next.vision.supported === null) {
      next.vision = {
        supported: true,
        source: "hint.kimi.multimodal",
      }
    }
    if (next.pdf.supported === null) {
      next.pdf = {
        supported: true,
        source: "hint.kimi.files",
      }
    }
    if (next.video.supported === null) {
      next.video = {
        supported: true,
        source: "hint.kimi.video",
      }
    }
  }

  if (
    normalized === "xiaomi/mimo-v2-5"
    || normalized === "xiaomi/mimo-v2-5-pro"
  ) {
    if (next.vision.supported === null) {
      next.vision = {
        supported: true,
        source: "hint.mimo.native_multimodal",
      }
    }
    if (next.pdf.supported === null) {
      next.pdf = {
        supported: true,
        source: "hint.mimo.pdf",
      }
    }
  }

  if (
    normalized === "moonshotai/kimi-k2-5"
    || normalized === "moonshotai/kimi-k2-6"
    || normalized === "xiaomi/mimo-v2-5"
    || normalized === "xiaomi/mimo-v2-5-pro"
    || normalized === "deepseek/deepseek-v4-pro"
    || normalized === "deepseek/deepseek-v4-flash"
    || normalized === "zai-org/glm-5"
    || normalized === "zai-org/glm-5-1"
  ) {
    if (next.reasoning.supported === null) {
      next.reasoning = {
        supported: true,
        source: "hint.reasoning.known_model",
      }
    }
  }

  return next
}

function normalizeStoredVisionCapability(info) {
  if (!info || typeof info !== "object") {
    return { supported: null, source: null }
  }

  const capabilities = isRecord(info.capabilities) ? info.capabilities : null
  const vision = isRecord(capabilities?.vision) ? capabilities.vision : null
  if (vision) {
    return {
      supported: firstBoolean(vision.supported),
      source: firstString(vision.source) || null,
    }
  }

  return {
    supported: firstBoolean(info?.image?.ok),
    source: null,
  }
}

function normalizeStoredPdfCapability(info) {
  if (!info || typeof info !== "object") {
    return { supported: null, source: null }
  }

  const capabilities = isRecord(info.capabilities) ? info.capabilities : null
  const pdf = isRecord(capabilities?.pdf) ? capabilities.pdf : null
  if (pdf) {
    return {
      supported: firstBoolean(pdf.supported),
      source: firstString(pdf.source) || null,
    }
  }

  return {
    supported: null,
    source: null,
  }
}

function normalizeStoredGenericCapability(info, key) {
  if (!info || typeof info !== "object") {
    return { supported: null, source: null }
  }

  const capabilities = isRecord(info.capabilities) ? info.capabilities : null
  const entry = isRecord(capabilities?.[key]) ? capabilities[key] : null
  if (entry) {
    return {
      supported: firstBoolean(entry.supported),
      source: firstString(entry.source) || null,
    }
  }

  return {
    supported: null,
    source: null,
  }
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

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value
  }
  return null
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value
  }
  return null
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return []
  return values
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.trim().toLowerCase())
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
