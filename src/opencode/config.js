import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths, ensureParentDir } from "../config/paths.js"
import { readSecrets } from "../config/store.js"
import { deriveCatalogFromCompatibility, fallbackCatalog } from "../shared/catalog.js"
import {
  commandCodeEffortLevelsForModel,
  commandCodeReasoningInterleavedField,
  supportsCommandCodeEffortSelection,
  supportsCommandCodeReasoning,
} from "../shared/commandcode-thinking.js"
import { resolveContextWindow } from "../shared/context-windows.js"

export function detectOpenCodeInstallations() {
  const paths = getPaths()
  return {
    configFound: existsSync(paths.opencodeConfigFile),
    desktop: detectDesktopPath(),
    cli: detectCliPath(),
    configFile: paths.opencodeConfigFile,
  }
}

export function syncOpenCodeConfig({ host, port, providers = [], createIfMissing = false }) {
  const paths = getPaths()
  const secrets = readSecrets()
  if (!existsSync(paths.opencodeConfigFile) && !createIfMissing) return null
  ensureParentDir(paths.opencodeConfigFile)
  const config = readJson(paths.opencodeConfigFile) || { $schema: "https://opencode.ai/config.json" }
  config.provider ||= {}
  for (const provider of providers) {
    if (!provider?.id || !provider?.compatibilityMatrix) continue
    config.provider[provider.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
        baseURL: `http://${host}:${port}/${provider.routePrefix}/v1`,
        headers: {
          "x-ocg-token": secrets.shimAccessToken,
        },
      },
      models: buildModelConfig(provider),
    }
  }
  writeFileSync(paths.opencodeConfigFile, JSON.stringify(config, null, 2), "utf8")
  return paths.opencodeConfigFile
}

export function inspectOpenCodeProvider(providerId) {
  const paths = getPaths()
  const config = readJson(paths.opencodeConfigFile)
  if (!config?.provider?.[providerId]) return null
  return config.provider[providerId]
}

export function removeOpenCodeProvider(providerId) {
  const paths = getPaths()
  const config = readJson(paths.opencodeConfigFile)
  if (!config?.provider?.[providerId]) return false
  delete config.provider[providerId]
  if (config.model === `${providerId}/moonshotai/Kimi-K2.5` || String(config.model || "").startsWith(`${providerId}/`)) {
    delete config.model
  }
  writeFileSync(paths.opencodeConfigFile, JSON.stringify(config, null, 2), "utf8")
  return true
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
    const supportedInputs = resolveSupportedInputs(compat)
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
      capabilities: {
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
      },
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

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
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
