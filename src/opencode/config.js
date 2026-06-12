import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths, ensureParentDir } from "../config/paths.js"
import { readSecrets } from "../config/store.js"
import { deriveCatalogFromCompatibility, fallbackCatalog } from "../shared/catalog.js"

export function detectOpenCodeInstallations() {
  const paths = getPaths()
  return {
    configFound: existsSync(paths.opencodeConfigFile),
    desktop: detectDesktopPath(),
    cli: detectCliPath(),
    configFile: paths.opencodeConfigFile,
  }
}

export function syncOpenCodeConfig({ providerId, host, port, compatibilityMatrix, createIfMissing = false }) {
  const paths = getPaths()
  const secrets = readSecrets()
  if (!existsSync(paths.opencodeConfigFile) && !createIfMissing) return null
  ensureParentDir(paths.opencodeConfigFile)
  const config = readJson(paths.opencodeConfigFile) || { $schema: "https://opencode.ai/config.json" }
  config.provider ||= {}
  config.provider[providerId] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Command Code Shim",
    options: {
      baseURL: `http://${host}:${port}/v1`,
      headers: {
        "X-CommandCode-Shim-Token": secrets.shimAccessToken,
      },
    },
    models: buildModelConfig(compatibilityMatrix),
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

function buildModelConfig(compatibilityMatrix) {
  const models = {}
  const catalog = deriveCatalogFromCompatibility(compatibilityMatrix)
  for (const { id, name, context_length } of catalog.length > 0 ? catalog : fallbackCatalog()) {
    const compat = compatibilityMatrix?.models?.[id]
    if (compat?.status === "broken") continue
    const supportsImage = !!compat?.image?.ok
    const supportsReasoning = !!compat?.reasoning?.ok
    models[id] = {
      name,
      limit: {
        context: context_length || 200000,
        output: 32768,
      },
      modalities: {
        input: supportsImage ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      ...(supportsReasoning
        ? {
            variants: {
              default: {
                label: "Reasoning",
              },
            },
          }
        : {}),
    }
  }
  return models
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
