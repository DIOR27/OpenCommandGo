import { syncOpenCodeConfig } from "../opencode/config.js"
import { deriveCatalogFromCompatibility } from "../shared/catalog.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { extractOpenRouterModelRows, normalizeOpenRouterCatalogRows } from "../shared/openrouter.js"

const REFRESH_PROBE_TIMEOUT_MS = 25000

export function createOpenRouterCatalogController({ initialCompatibilityMatrix, writeCompatibilityMatrix, log }) {
  let compatibilityMatrix = initialCompatibilityMatrix
  let availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
  let compatibilityRefreshRunning = false

  return {
    getCompatibilityMatrix: () => compatibilityMatrix,
    getAvailableCatalog: () => availableCatalog,
    buildModelList: () => availableCatalog.map(model => buildModelDescriptor(model, compatibilityMatrix?.models?.[model.id])),
    syncProviderConfig(settings, commandCodeCompatibilityMatrix) {
      syncOpenCodeConfig({
        host: settings.host,
        port: settings.port,
        providers: [
          {
            id: settings.providerId,
            kind: "commandcode",
            routePrefix: "cmdshim",
            name: "OCG CommandCode",
            compatibilityMatrix: commandCodeCompatibilityMatrix,
          },
          {
            id: settings.openRouterProviderId,
            kind: "openrouter",
            routePrefix: "openrouter",
            name: "OCG OpenRouter Free",
            compatibilityMatrix,
          },
        ],
      })
    },
    async refreshNow(settings, options = {}) {
      const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
      return await maybeRefreshCompatibility("manual", refreshMs, settings, {
        force: true,
        verifyAvailability: options.verifyAvailability === true,
        concurrency: options.concurrency,
        onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
      })
    },
    schedule(settings, commandCodeCompatibilityMatrix) {
      const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
      void maybeRefreshCompatibility("startup-force", refreshMs, settings, { commandCodeCompatibilityMatrix })
      setInterval(() => {
        void maybeRefreshCompatibility("interval", refreshMs, settings, { commandCodeCompatibilityMatrix })
      }, refreshMs)
    },
  }

  async function maybeRefreshCompatibility(reason, refreshMs, settings, options = {}) {
    if (compatibilityRefreshRunning) return compatibilityMatrix
    const updatedAt = compatibilityMatrix.updated_at ? Date.parse(compatibilityMatrix.updated_at) : 0
    const stale = !updatedAt || Number.isNaN(updatedAt) || (Date.now() - updatedAt >= refreshMs)
    if (!options.force && !stale && reason !== "startup-force") return compatibilityMatrix

    compatibilityRefreshRunning = true
    log(`OPENROUTER refresh_start reason=${reason}`)
    try {
      options.onProgress?.({ type: "catalog", message: "consultando modelos gratis..." })
      const catalog = await fetchAvailableCatalog(settings)
      options.onProgress?.({ type: "catalog", message: `${catalog.length} modelos gratis detectados` })
      const next = {
        updated_at: new Date().toISOString(),
        refresh_interval_hours: settings.compatibilityRefreshHours,
        models: {},
      }

      const verifyAvailability = options.verifyAvailability === true
      for (let index = 0; index < catalog.length; index += 1) {
        const row = catalog[index]
        options.onProgress?.({
          type: "model-start",
          index: index + 1,
          total: catalog.length,
          model: row.id,
        })

        const entry = verifyAvailability
          ? await probeModelAvailability(row, settings)
          : buildCatalogOnlyCompatibilityEntry(row)
        next.models[row.id] = entry
        options.onProgress?.({
          type: "model-done",
          index: index + 1,
          total: catalog.length,
          model: row.id,
          status: entry.status,
        })
      }

      compatibilityMatrix = next
      availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
      writeCompatibilityMatrix(compatibilityMatrix)
      syncOpenCodeConfig({
        host: settings.host,
        port: settings.port,
        providers: [
          {
            id: settings.providerId,
            kind: "commandcode",
            routePrefix: "cmdshim",
            name: "OCG CommandCode",
            compatibilityMatrix: options.commandCodeCompatibilityMatrix || { models: {} },
          },
          {
            id: settings.openRouterProviderId,
            kind: "openrouter",
            routePrefix: "openrouter",
            name: "OCG OpenRouter Free",
            compatibilityMatrix,
          },
        ],
      })
      log(`OPENROUTER refresh_done models=${Object.keys(next.models).length}`)
      return compatibilityMatrix
    } catch (error) {
      log(`OPENROUTER refresh_error ${error instanceof Error ? error.stack || error.message : String(error)}`)
      throw error
    } finally {
      compatibilityRefreshRunning = false
    }
  }
}

async function fetchAvailableCatalog(settings) {
  const response = await fetch(`${settings.openRouterBaseUrl}/models`, {
    headers: buildOpenRouterHeaders(settings),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`OpenRouter models ${response.status}`)
  const data = await response.json()
  return normalizeOpenRouterCatalogRows(extractOpenRouterModelRows(data))
}

async function probeModelAvailability(row, settings) {
  const entry = buildCatalogOnlyCompatibilityEntry(row)
  const response = await fetch(`${settings.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: buildOpenRouterHeaders(settings),
    signal: AbortSignal.timeout(REFRESH_PROBE_TIMEOUT_MS),
    body: JSON.stringify({
      model: row.id,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  })

  entry.tested_at = new Date().toISOString()
  entry.last_probe_status = response.ok ? "available" : `http_${response.status}`

  if (response.ok) {
    entry.status = "available"
    entry.text = { ok: true, output_chars: 0 }
    return entry
  }

  const raw = await response.text()
  if (response.status === 429 || response.status === 402 || response.status === 403) {
    entry.status = "quota_blocked"
  } else {
    entry.status = "broken"
  }
  entry.notes = raw.slice(0, 500)
  return entry
}

function buildCatalogOnlyCompatibilityEntry(row) {
  return {
    name: row.name,
    tags: Array.isArray(row.tags) ? row.tags : [],
    context_length: resolveContextWindow(row.id, row.context_length),
    status: "available",
    tested_at: new Date().toISOString(),
    last_probe_status: "catalog_only",
    pricing: row.pricing || {},
    supported_parameters: Array.isArray(row.supported_parameters) ? row.supported_parameters : [],
    capabilities: {
      vision: normalizeCapability(row.catalog_capabilities?.vision),
      pdf: normalizeCapability(row.catalog_capabilities?.pdf),
      audio: normalizeCapability(row.catalog_capabilities?.audio),
      video: normalizeCapability(row.catalog_capabilities?.video),
      reasoning: normalizeReasoningCapability(row.catalog_capabilities?.reasoning),
    },
  }
}

function buildModelDescriptor(model, compat) {
  const contextWindow = resolveContextWindow(model.id, model.context_length)
  const inputModalities = resolveInputModalities(compat)
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "openrouter",
    name: model.name,
    context_length: contextWindow,
    limit: {
      context: contextWindow,
      output: 32768,
    },
    modalities: {
      input: inputModalities,
      output: ["text"],
    },
    capabilities: {
      vision: compat?.capabilities?.vision || { supported: false, source: null },
      pdf: compat?.capabilities?.pdf || { supported: false, source: null },
      audio: compat?.capabilities?.audio || { supported: false, source: null },
      video: compat?.capabilities?.video || { supported: false, source: null },
    },
    ...(compat?.capabilities?.reasoning?.supported === true ? { reasoning: true } : {}),
    status: compat?.status || "unknown",
  }
}

function resolveInputModalities(compat) {
  const inputs = ["text"]
  if (compat?.capabilities?.vision?.supported) inputs.push("image")
  if (compat?.capabilities?.pdf?.supported) inputs.push("pdf")
  if (compat?.capabilities?.audio?.supported) inputs.push("audio")
  if (compat?.capabilities?.video?.supported) inputs.push("video")
  return inputs
}

function normalizeCapability(value) {
  return {
    supported: value?.supported === true,
    source: typeof value?.source === "string" ? value.source : null,
  }
}

function normalizeReasoningCapability(value) {
  return {
    supported: value?.supported === true,
    source: typeof value?.source === "string" ? value.source : null,
    supported_efforts: Array.isArray(value?.supported_efforts) ? value.supported_efforts : [],
  }
}

function buildOpenRouterHeaders(settings) {
  return {
    "Authorization": `Bearer ${settings.openRouterApiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  }
}
