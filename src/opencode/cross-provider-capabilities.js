import { existsSync, readFileSync } from "node:fs"
import { parseJsonLike } from "../shared/json.js"

const CAPABILITY_KEYS = ["vision", "pdf", "audio", "video"]
const EXTRA_INPUT_MODALITIES = ["image", "pdf", "audio", "video"]

export function comparableModelId(id) {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[ _.]+/g, "-")
}

export function providerlessModelId(id) {
  const value = String(id || "")
  const slashIndex = value.indexOf("/")
  return comparableModelId(slashIndex >= 0 ? value.slice(slashIndex + 1) : value)
}

export function readOpenCodeConfigFor(paths) {
  const candidates = paths?.opencodeConfigFile
    ? [`${paths.opencodeConfigFile}c`, paths.opencodeConfigFile]
    : []
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    try {
      const raw = parseJsonLike(readFileSync(file, "utf8"))
      if (raw && typeof raw === "object") return raw
    } catch {
      // try next candidate
    }
  }
  return {}
}

export function buildComparableProviderModels(existingProviders, excludeIds) {
  const excluded = new Set((excludeIds || []).filter(Boolean))
  return Object.fromEntries(
    Object.entries(existingProviders || {})
      .filter(([providerId, providerConfig]) => !excluded.has(providerId) && providerConfig?.models && typeof providerConfig.models === "object")
      .map(([providerId, providerConfig]) => [providerId, providerConfig.models]),
  )
}

export function rankMatchCandidates(commandcodeModelId, otherProvidersModels, options = {}) {
  const exactComparable = comparableModelId(commandcodeModelId)
  const commandcodeProviderless = providerlessModelId(commandcodeModelId)
  const matches = []
  const sourceRank = Number.isInteger(options.sourceRank) ? options.sourceRank : 0
  const sourceTag = typeof options.sourceTag === "string" && options.sourceTag.trim() ? options.sourceTag.trim() : "cross-provider"
  for (const [providerId, models] of Object.entries(otherProvidersModels || {})) {
    if (!models || typeof models !== "object") continue
    for (const [modelId, modelEntry] of Object.entries(models)) {
      const candidateComparable = comparableModelId(modelId)
      const candidateProviderless = providerlessModelId(modelId)
      const score = candidateComparable === exactComparable
        ? 100
        : candidateProviderless === commandcodeProviderless
          ? 80
          : 0
      if (!score) continue
      matches.push({ providerId, modelEntry, score, sourceRank, sourceTag })
    }
  }
  return matches.sort((left, right) => (
    right.score - left.score
    || left.sourceRank - right.sourceRank
    || scoreRichness(right.modelEntry) - scoreRichness(left.modelEntry)
    || left.providerId.localeCompare(right.providerId)
  ))
}

export function pickRichestMatch(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null
  const highestScore = Math.max(...matches.map(match => Number(match?.score || 0)))
  return matches
    .filter(match => Number(match?.score || 0) === highestScore)
    .sort((left, right) => (
      left.sourceRank - right.sourceRank
      || scoreRichness(right.modelEntry) - scoreRichness(left.modelEntry)
      || left.providerId.localeCompare(right.providerId)
    ))[0] || null
}

export function scoreRichness(modelEntry) {
  const entry = modelEntry && typeof modelEntry === "object" ? modelEntry : {}
  let score = 0
  for (const key of CAPABILITY_KEYS) {
    if (entry?.capabilities?.[key]?.supported !== null && entry?.capabilities?.[key]?.supported !== undefined) {
      score += 1
    }
  }
  if (entry?.reasoning !== null && entry?.reasoning !== undefined) score += 1
  if (entry?.limit?.context !== null && entry?.limit?.context !== undefined) score += 1
  return score
}

export function mergeCrossProviderCapabilities({ commandcodeModels, providerSources = [] }) {
  const models = commandcodeModels && typeof commandcodeModels === "object" ? commandcodeModels : {}

  let mergedCount = 0
  for (const [modelId, commandcodeEntry] of Object.entries(models)) {
    if (!commandcodeEntry || typeof commandcodeEntry !== "object") continue
    const match = pickRichestMatch(providerSources.flatMap((source, index) => (
      rankMatchCandidates(modelId, source?.providers, {
        sourceRank: Number.isInteger(source?.rank) ? source.rank : index,
        sourceTag: source?.tagPrefix,
      })
    )))
    if (!match?.modelEntry) continue
    const merged = mergeModelEntry(commandcodeEntry, match.modelEntry, `${match.sourceTag}:${match.providerId}`)
    if (merged) mergedCount += 1
  }
  return mergedCount
}

function mergeModelEntry(target, source, sourceTag) {
  let changed = false

  const targetInputs = Array.isArray(target?.modalities?.input) ? target.modalities.input : null
  const sourceInputs = Array.isArray(source?.modalities?.input) ? source.modalities.input : []
  if (targetInputs && targetInputs.length === 1 && targetInputs[0] === "text") {
    const extras = EXTRA_INPUT_MODALITIES.filter(modality => sourceInputs.includes(modality))
    if (extras.length > 0) {
      target.modalities.input = [...targetInputs, ...extras]
      changed = true
    }
  }

  target.capabilities ||= {}
  for (const key of CAPABILITY_KEYS) {
    const sourceSupported = source?.capabilities?.[key]?.supported
    const currentSupported = target?.capabilities?.[key]?.supported
    if (sourceSupported !== true || currentSupported !== null && currentSupported !== undefined) continue
    target.capabilities[key] ||= {}
    target.capabilities[key].supported = true
    target.capabilities[key].source = target.capabilities[key].source || sourceTag
    changed = true
  }

  if ((target.reasoning === null || target.reasoning === undefined) && source?.reasoning === true) {
    target.reasoning = true
    changed = true
  }

  if (target?.limit?.context === null || target?.limit?.context === undefined) {
    const sourceContext = source?.limit?.context
    if (sourceContext !== null && sourceContext !== undefined) {
      target.limit ||= {}
      target.limit.context = sourceContext
      changed = true
    }
  }

  return changed
}
