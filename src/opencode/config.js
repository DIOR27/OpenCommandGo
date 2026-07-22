import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths, ensureParentDir } from "../config/paths.js"
import { readSecrets } from "../config/store.js"
import { deriveCatalogFromCompatibility, fallbackCatalog } from "../shared/catalog.js"
import {
  COMMANDCODE_PROVIDER,
  resolveBridgeCapabilities,
  resolveBridgeInputModalities,
} from "../shared/models.js"
import {
  commandCodeEffortLevelsForModel,
  commandCodeReasoningInterleavedField,
  supportsCommandCodeEffortSelection,
  supportsCommandCodeReasoning,
} from "../shared/commandcode-thinking.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { parseJsonLike } from "../shared/json.js"
import {
  buildComparableProviderModels,
  mergeCrossProviderCapabilities,
  readOpenCodeConfigFor,
} from "./cross-provider-capabilities.js"
import { readResolvedProvidersFromSidecar } from "./sidecar-resolved-providers.js"

const JSON_PARSE_FAILED = Symbol("json-parse-failed")

// Serialization queue for syncOpenCodeConfig — prevents race conditions
// when concurrent calls read stale state and overwrite each other's writes.
let syncQueue = Promise.resolve()

export function detectOpenCodeInstallations() {
  const paths = getPaths()
  const configFile = resolvePrimaryOpenCodeConfigFile(paths, { createIfMissing: false }) || paths.opencodeConfigFile
  return {
    configFound: hasAnyOpenCodeConfigFile(paths),
    desktop: detectDesktopPath(),
    cli: detectCliPath(),
    configFile,
  }
}

export async function syncOpenCodeConfig({
  host,
  port,
  providers = [],
  createIfMissing = false,
  resolvedProviderMetadata = null,
  readResolvedProviders = readResolvedProvidersFromSidecar,
} = {}) {
  // Serialize concurrent syncs: each call waits for the previous to finish
  // before reading the config file. This prevents race conditions where
  // concurrent writes overwrite each other with stale data.
  const prevQueue = syncQueue
  let nextDone
  syncQueue = new Promise(resolve => { nextDone = resolve })
  await prevQueue
  try {
    const paths = getPaths()
    const secrets = readSecrets()
    const targetFile = resolvePrimaryOpenCodeConfigFile(paths, { createIfMissing })
    if (!targetFile) return null
    ensureParentDir(targetFile)
    const config = readJson(targetFile, { parseFailureValue: JSON_PARSE_FAILED })
    if (config === JSON_PARSE_FAILED) return targetFile
    const existingConfig = readOpenCodeConfigFor(paths)
    const runtimeProviders = await readComparableRuntimeProviders({ resolvedProviderMetadata, readResolvedProviders })
    const previouslyConfiguredProviderIds = collectConfiguredProviderIds(paths)
    const nextConfig = config || { $schema: "https://opencode.ai/config.json" }
    nextConfig.provider ||= {}

    // Collect provider IDs the user explicitly disabled — we MUST respect
    // this choice and NOT re-create provider entries they chose to disable.
    const disabledProviderIds = new Set(
      (config?.disabled_providers || [])
        .map(id => String(id || "").trim())
        .filter(Boolean),
    )

    const enabledProviderIds = new Set()
    for (const provider of providers) {
      if (!provider?.id || !provider?.compatibilityMatrix) continue
      const syncedIds = resolveSyncedProviderIds(provider)
      for (const id of syncedIds) enabledProviderIds.add(id)
      const providerConfig = buildProviderConfig({ host, port, provider, token: secrets.shimAccessToken })
      if (provider.kind === "commandcode") {
        mergeCrossProviderCapabilities({
          commandcodeModels: providerConfig.models,
          providerSources: buildCrossProviderSources({
            runtimeProviders,
            existingProviders: existingConfig?.provider || {},
            excludeIds: ["commandcode", "ocg", provider.id],
          }),
        })
      }
      for (const id of syncedIds) {
        // Respect user's explicit choice: skip IDs they disabled
        if (disabledProviderIds.has(id)) continue
        nextConfig.provider[id] = providerConfig
      }
    }
    stripDisabledProviders(nextConfig, enabledProviderIds, previouslyConfiguredProviderIds)
    writeFileSync(targetFile, JSON.stringify(nextConfig, null, 2), "utf8")
    syncDisabledProviderLists(paths, enabledProviderIds, targetFile, previouslyConfiguredProviderIds)
    return targetFile
  } finally {
    nextDone()
  }
}

export function inspectOpenCodeProvider(providerId) {
  const paths = getPaths()
  const config = readJson(resolvePrimaryOpenCodeConfigFile(paths, { createIfMissing: false }) || paths.opencodeConfigFile)
  for (const candidate of resolveProviderLookupIds(providerId)) {
    if (config?.provider?.[candidate]) return config.provider[candidate]
  }
  return null
}

export function removeOpenCodeProvider(providerId) {
  const paths = getPaths()
  const targetFile = resolvePrimaryOpenCodeConfigFile(paths, { createIfMissing: false })
  if (!targetFile) return false
  const config = readJson(targetFile)
  if (!config?.provider) return false
  const providerIds = resolveProviderLookupIds(providerId)
  const removed = providerIds.some(candidate => config?.provider?.[candidate])
  if (!removed) return false
  for (const candidate of providerIds) {
    delete config.provider[candidate]
  }
  const currentModel = String(config.model || "")
  if (providerIds.some(candidate => currentModel.startsWith(`${candidate}/`))) {
    delete config.model
  }
  writeFileSync(targetFile, JSON.stringify(config, null, 2), "utf8")
  return true
}

function buildProviderConfig({ host, port, provider, token }) {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: provider.kind === "commandcode" ? COMMANDCODE_PROVIDER.name : provider.name,
    options: {
      baseURL: `http://${host}:${port}/${provider.routePrefix}/v1`,
      headers: {
        "x-ocg-token": token,
      },
    },
    models: buildModelConfig(provider),
  }
}

function buildCrossProviderSources({ runtimeProviders, existingProviders, excludeIds }) {
  const sources = []
  const comparableRuntimeProviders = buildComparableProviderModels(runtimeProviders, excludeIds)
  if (Object.keys(comparableRuntimeProviders).length > 0) {
    sources.push({ rank: 0, tagPrefix: "cross-provider-sidecar", providers: comparableRuntimeProviders })
  }
  const comparableConfigProviders = buildComparableProviderModels(existingProviders, excludeIds)
  if (Object.keys(comparableConfigProviders).length > 0) {
    sources.push({ rank: 1, tagPrefix: "cross-provider-config", providers: comparableConfigProviders })
  }
  return sources
}

async function readComparableRuntimeProviders({ resolvedProviderMetadata, readResolvedProviders }) {
  if (resolvedProviderMetadata && typeof resolvedProviderMetadata === "object") {
    return resolvedProviderMetadata
  }
  if (typeof readResolvedProviders !== "function") return {}
  try {
    const result = await readResolvedProviders()
    if (!result?.ok || !result.providers || typeof result.providers !== "object") return {}
    return result.providers
  } catch {
    return {}
  }
}

function buildModelConfig(provider) {
  const models = {}
  const compatibilityMatrix = provider.compatibilityMatrix
  const derivedCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
  const catalog = provider.kind === "commandcode"
    ? (derivedCatalog.length > 0 ? derivedCatalog : fallbackCatalog())
    : derivedCatalog
  for (const { id, name, context_length } of catalog) {
    const compat = compatibilityMatrix?.models?.[id]
    if (compat?.status === "broken") continue
    const supportedInputs = provider.kind === "commandcode"
      ? resolveBridgeInputModalities(compat)
      : resolveSupportedInputs(compat)
    const contextWindow = resolveContextWindow(id, context_length)
    const supportsReasoning = resolveReasoningSupport(id, compat)
    const interleavedField = provider.kind === "commandcode" ? commandCodeReasoningInterleavedField(id) : null
    models[id] = {
      name,
      limit: {
        context: contextWindow,
        output: 32768,
      },
      modalities: {
        input: supportedInputs,
        output: ["text"],
      },
      capabilities: provider.kind === "commandcode"
        ? resolveBridgeCapabilities(compat)
        : buildModelCapabilities(compat, supportedInputs),
      ...(supportsReasoning ? { reasoning: true } : {}),
      ...(interleavedField ? {
        interleaved: {
          field: interleavedField,
        },
      } : {}),
      ...(supportsReasoningVariants(id, compat) ? {
        variants: buildReasoningVariants(id, compat),
      } : {}),
    }
  }
  return models
}

function resolveReasoningSupport(modelId, compat) {
  const capabilityReasoning = compat?.capabilities?.reasoning?.supported
  if (typeof capabilityReasoning === "boolean") return capabilityReasoning
  return supportsCommandCodeReasoning(modelId, compat?.tags)
}

function resolveSupportedInputs(compat) {
  const inputs = ["text"]
  if (resolveCapabilitySupport(compat, "vision") === true || compat?.image?.ok === true) {
    inputs.push("image")
  }
  if (resolveCapabilitySupport(compat, "pdf") === true) {
    inputs.push("pdf")
  }
  if (resolveCapabilitySupport(compat, "audio") === true) {
    inputs.push("audio")
  }
  if (resolveCapabilitySupport(compat, "video") === true) {
    inputs.push("video")
  }
  return inputs
}

function buildModelCapabilities(compat, supportedInputs) {
  return {
    vision: {
      supported: supportedInputs.includes("image"),
      source: resolveCapabilitySource(compat, "vision"),
    },
    pdf: {
      supported: resolveCapabilitySupport(compat, "pdf"),
      source: resolveCapabilitySource(compat, "pdf"),
    },
    audio: {
      supported: resolveCapabilitySupport(compat, "audio"),
      source: resolveCapabilitySource(compat, "audio"),
    },
    video: {
      supported: resolveCapabilitySupport(compat, "video"),
      source: resolveCapabilitySource(compat, "video"),
    },
  }
}

function resolveSyncedProviderIds(provider) {
  if (provider.kind !== "commandcode") return [provider.id]
  return Array.from(new Set([
    COMMANDCODE_PROVIDER.id,
    ...COMMANDCODE_PROVIDER.legacyIds,
    provider.id,
  ].filter(Boolean)))
}

function resolveProviderLookupIds(providerId) {
  if (!providerId || providerId === COMMANDCODE_PROVIDER.id || COMMANDCODE_PROVIDER.legacyIds.includes(providerId)) {
    return [COMMANDCODE_PROVIDER.id, ...COMMANDCODE_PROVIDER.legacyIds]
  }
  return [providerId]
}

function supportsReasoningVariants(modelId, compat) {
  return supportsCommandCodeEffortSelection(modelId, compat?.tags)
}

function buildReasoningVariants(modelId, compat) {
  return Object.fromEntries(
    commandCodeEffortLevelsForModel(modelId).map(level => ([
      level,
      { thinkingLevel: level },
    ])),
  )
}

function resolveCapabilitySupport(compat, key) {
  const supported = compat?.capabilities?.[key]?.supported
  return typeof supported === "boolean" ? supported : null
}

function resolveCapabilitySource(compat, key) {
  const source = compat?.capabilities?.[key]?.source
  return typeof source === "string" && source.trim() ? source.trim() : null
}

function readJson(file, { parseFailureValue = null } = {}) {
  if (!existsSync(file)) return null
  try {
    return parseJsonLike(readFileSync(file, "utf8"))
  } catch {
    return parseFailureValue
  }
}

function hasAnyOpenCodeConfigFile(paths) {
  return getOpenCodeConfigCandidates(paths).some(file => existsSync(file))
}

function getOpenCodeConfigCandidates(paths) {
  // .jsonc first — OpenCode Desktop writes .jsonc
  return [`${paths.opencodeConfigFile}c`, paths.opencodeConfigFile]
}

function resolvePrimaryOpenCodeConfigFile(paths, { createIfMissing = false } = {}) {
  for (const file of getOpenCodeConfigCandidates(paths)) {
    if (existsSync(file)) return file
  }
  return createIfMissing ? paths.opencodeConfigFile : null
}

function stripDisabledProviders(config, enabledProviderIds, previouslyConfiguredProviderIds = new Set()) {
  if (!Array.isArray(config?.disabled_providers) || enabledProviderIds.size === 0) return
  config.disabled_providers = config.disabled_providers.filter(id => {
    const normalizedId = String(id || "").trim()
    return !enabledProviderIds.has(normalizedId) || previouslyConfiguredProviderIds.has(normalizedId)
  })
  if (config.disabled_providers.length === 0) delete config.disabled_providers
}

function syncDisabledProviderLists(paths, enabledProviderIds, primaryFile, previouslyConfiguredProviderIds) {
  if (enabledProviderIds.size === 0) return
  for (const file of getOpenCodeConfigCandidates(paths)) {
    if (!existsSync(file) || file === primaryFile) continue
    const config = readJson(file)
    if (!config) continue
    const before = JSON.stringify(config.disabled_providers || null)
    stripDisabledProviders(config, enabledProviderIds, previouslyConfiguredProviderIds)
    const after = JSON.stringify(config.disabled_providers || null)
    if (before !== after) {
      writeFileSync(file, JSON.stringify(config, null, 2), "utf8")
    }
  }
}

function collectConfiguredProviderIds(paths) {
  const configuredIds = new Set()
  for (const file of getOpenCodeConfigCandidates(paths)) {
    const config = readJson(file)
    if (!config?.provider || typeof config.provider !== "object") continue
    for (const id of Object.keys(config.provider)) {
      const normalizedId = String(id || "").trim()
      if (!normalizedId) continue
      for (const candidate of resolveProviderLookupIds(normalizedId)) {
        configuredIds.add(candidate)
      }
    }
  }
  return configuredIds
}

function detectDesktopPath() {
  if (process.platform !== "win32") return null
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs", "OpenCode", "OpenCode.exe"),
    join(process.env.ProgramFiles || "", "OpenCode", "OpenCode.exe"),
  ].filter(Boolean)
  return candidates.find(candidate => candidate && existsSync(candidate)) || null
}

function detectCliPath() {
  const candidates = []
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || ""
    candidates.push(join(appData, "npm", "opencode.cmd"))
    candidates.push(join(appData, "npm", "opencode"))
  }
  const pathDirs = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean)
  for (const dir of pathDirs) {
    candidates.push(join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode"))
    candidates.push(join(dir, "opencode"))
  }
  return candidates.find(candidate => candidate && existsSync(candidate)) || null
}
