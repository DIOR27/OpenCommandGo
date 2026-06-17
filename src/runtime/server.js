import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { getPaths, ensureDir } from "../config/paths.js"
import { clearPid, getRuntimeSettings, readCompatibilityMatrix, writeCompatibilityMatrix, writePid } from "../config/store.js"
import { syncOpenCodeConfig } from "../opencode/config.js"
import { MODELS, MODEL_SET } from "../shared/models.js"
import { deriveCatalogFromCompatibility, extractModelRows, fallbackCatalog, normalizeCatalogRows } from "../shared/catalog.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { rotateLogIfNeeded } from "../shared/log-rotation.js"
import { t } from "../shared/i18n.js"
import { buildOpenAICompletion, callCommandCodeAlpha, collectReasoning, collectText, collectToolCalls, extractUsage, startCommandCodeAlphaStream, streamOpenAIResponse, summarizeIncomingMessages } from "./chat-bridge.js"
import { isLoopbackHost, json, openAIError, readJson, requireShimAuth } from "./http-utils.js"

const IMAGE_TEST_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg"
const UPSTREAM_TIMEOUT_MS = 120000
const REFRESH_PROBE_TIMEOUT_MS = 25000

let compatibilityMatrix = readCompatibilityMatrix()
let compatibilityRefreshRunning = false
let currentServer = null
let availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)

export async function refreshModelCatalogNow(options = {}) {
  const settings = getRuntimeSettings()
  const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
  return await maybeRefreshCompatibility("manual", refreshMs, settings, {
    force: true,
    probeMode: options.probeMode || "catalog",
    verifyAvailability: options.verifyAvailability === true,
    concurrency: options.concurrency,
    onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
  })
}

export async function startServer() {
  if (currentServer) return currentServer

  const settings = getRuntimeSettings()
  if (!settings.allowRemoteHost && !isLoopbackHost(settings.host)) {
    throw new Error(t("error.host_not_allowed", settings.host))
  }
  const paths = getPaths()
  ensureDir(paths.logDir)
  syncOpenCodeConfig({
    providerId: settings.providerId,
    host: settings.host,
    port: settings.port,
    compatibilityMatrix,
  })

  const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)

      if (req.method === "GET" && url.pathname === "/health") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          ok: true,
          provider: "ocg",
          host: settings.host,
          port: settings.port,
          models: availableCatalog.map(({ id, name }) => ({ id, name })),
          compatibility_updated_at: compatibilityMatrix.updated_at || null,
        })
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        if (!requireShimAuth(req, res, settings)) return
        log("SHUTDOWN requested via /shutdown endpoint")
        json(res, 200, { ok: true, message: "Shutting down" })
        setImmediate(() => {
          clearPid()
          if (currentServer) {
            currentServer.close(() => {
              process.exit(0)
            })
          } else {
            process.exit(0)
          }
        })
        return
      }

      if (req.method === "GET" && url.pathname === "/compatibility") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, compatibilityMatrix)
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          object: "list",
          data: availableCatalog.map(model => buildModelDescriptor(model, compatibilityMatrix?.models?.[model.id])),
        })
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!requireShimAuth(req, res, settings)) return
        if (!settings.commandCodeApiKey) {
          return json(res, 500, openAIError("missing_api_key", t("error.missing_api_key")))
        }

        const body = await readJson(req)
        if (!body || typeof body !== "object") {
          return json(res, 400, openAIError("invalid_request_error", "Body JSON inválido"))
        }
        log(`REQUEST raw model=${body.model || ""} content_summary=${summarizeIncomingMessages(body.messages)}`)

        const model = typeof body.model === "string" ? body.model.trim() : ""
        const currentModelSet = new Set(availableCatalog.map(entry => entry.id))
        if (!MODEL_SET.has(model) && !currentModelSet.has(model)) {
          return json(res, 400, openAIError("model_not_allowed", `Modelo no permitido: ${model || "(vacío)"}`))
        }

        if (body.stream === true) {
          const upstream = await startCommandCodeAlphaStream(body, model, settings, { log })
          return streamOpenAIResponse(res, model, upstream, { log })
        }

        const upstream = await callCommandCodeAlpha(body, model, settings, { log })
        return json(res, 200, buildOpenAICompletion(model, upstream))
      }

      json(res, 404, openAIError("not_found", `Ruta no soportada: ${req.method} ${url.pathname}`))
    } catch (error) {
      log(`ERROR ${error instanceof Error ? error.stack || error.message : String(error)}`)
      json(res, 500, openAIError("server_error", error instanceof Error ? error.message : "Error interno"))
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(settings.port, settings.host, resolve)
  })
  currentServer = server
  writePid(process.pid)
  process.on("exit", () => clearPid())
  process.on("SIGINT", () => {
    clearPid()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    clearPid()
    process.exit(0)
  })

  log(`LISTEN http://${settings.host}:${settings.port}`)
  console.log(t("server.listening", settings.host, settings.port))
  scheduleCompatibilityRefresh(refreshMs, settings)
  return server
}

function log(line) {
  const paths = getPaths()
  ensureDir(paths.logDir)
  rotateLogIfNeeded(paths.logFile)
  appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${line}\n`)
}

function scheduleCompatibilityRefresh(refreshMs, settings) {
  void maybeRefreshCompatibility("startup-force", refreshMs, settings)
  setInterval(() => {
    void maybeRefreshCompatibility("interval", refreshMs, settings)
  }, refreshMs)
}

async function maybeRefreshCompatibility(reason, refreshMs, settings, options = {}) {
  if (compatibilityRefreshRunning) return
  const updatedAt = compatibilityMatrix.updated_at ? Date.parse(compatibilityMatrix.updated_at) : 0
  const stale = !updatedAt || Number.isNaN(updatedAt) || (Date.now() - updatedAt >= refreshMs)
  if (!options.force && !stale && reason !== "startup-force") return compatibilityMatrix

  compatibilityRefreshRunning = true
  log(`COMPAT refresh_start reason=${reason}`)
  try {
    options.onProgress?.({
      type: "catalog",
      message: "consultando modelos...",
    })
    const catalog = await fetchAvailableCatalog(settings)
    options.onProgress?.({
      type: "catalog",
      message: `${catalog.length} modelos detectados`,
    })
    const next = {
      updated_at: new Date().toISOString(),
      refresh_interval_hours: settings.compatibilityRefreshHours,
      models: {},
    }
    const verifyAvailability = options.verifyAvailability === true
    const probeMode = options.probeMode === "full"
      ? "full"
      : options.probeMode === "fast"
        ? "fast"
        : "catalog"
    const concurrency = resolveRefreshConcurrency(options.concurrency, probeMode, catalog.length)

    if (!verifyAvailability || probeMode === "catalog") {
      for (const row of catalog) {
        const { id, name, context_length, catalog_capabilities } = row
        const previous = compatibilityMatrix?.models?.[id]
        next.models[id] = buildCatalogOnlyCompatibilityEntry({
          id,
          name,
          context_length,
          catalogCapabilities: catalog_capabilities,
          previous,
        })
      }

      compatibilityMatrix = next
      availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
      writeCompatibilityMatrix(compatibilityMatrix)
      syncOpenCodeConfig({
        providerId: settings.providerId,
        host: settings.host,
        port: settings.port,
        compatibilityMatrix,
      })
      log(`COMPAT refresh_done models=${Object.keys(next.models).length} mode=catalog`)
      return compatibilityMatrix
    }

    let nextIndex = 0

    const runOne = async rowIndex => {
      const row = catalog[rowIndex]
      const { id, name, context_length, catalog_capabilities } = row
      options.onProgress?.({
        type: "model-start",
        index: rowIndex + 1,
        total: catalog.length,
        model: id,
      })

      const tested = await testModelCompatibility(id, name, settings, {
        catalogCapabilities: catalog_capabilities,
        probeMode,
      })
      tested.context_length = resolveContextWindow(id, context_length)
      const previous = compatibilityMatrix?.models?.[id]

      if (shouldPreservePreviousCompatibility(tested, previous)) {
        next.models[id] = {
          ...previous,
          name,
          context_length: resolveContextWindow(id, context_length),
          capabilities: mergeCapabilities(previous?.capabilities, tested.capabilities),
          tested_at: tested.tested_at,
          last_probe_status: tested.status,
          last_probe_notes: tested.notes,
        }
        options.onProgress?.({
          type: "model-done",
          index: rowIndex + 1,
          total: catalog.length,
          model: id,
          status: next.models[id].status,
        })
        return
      }

      next.models[id] = tested
      options.onProgress?.({
        type: "model-done",
        index: rowIndex + 1,
        total: catalog.length,
        model: id,
        status: tested.status,
      })
    }

    const worker = async () => {
      while (true) {
        const rowIndex = nextIndex
        nextIndex += 1
        if (rowIndex >= catalog.length) return
        await runOne(rowIndex)
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    )

    compatibilityMatrix = next
    availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
    writeCompatibilityMatrix(compatibilityMatrix)
    syncOpenCodeConfig({
      providerId: settings.providerId,
      host: settings.host,
      port: settings.port,
      compatibilityMatrix,
    })
    log(`COMPAT refresh_done models=${Object.keys(next.models).length}`)
    return compatibilityMatrix
  } catch (error) {
    log(`COMPAT refresh_error ${error instanceof Error ? error.stack || error.message : String(error)}`)
    throw error
  } finally {
    compatibilityRefreshRunning = false
  }
}

async function fetchAvailableCatalog(settings) {
  try {
    const response = await fetch(`${settings.commandCodeBaseUrl}/provider/v1/models`, {
      headers: {
        Authorization: `Bearer ${settings.commandCodeApiKey}`,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(t("error.upstream_models", response.status))
    const data = await response.json()
    const rows = normalizeCatalogRows(extractModelRows(data))
    if (rows.length > 0) return rows
  } catch (error) {
    log(`CATALOG fetch_error ${error instanceof Error ? error.message : String(error)}`)
  }

  const derived = deriveCatalogFromCompatibility(compatibilityMatrix)
  if (derived.length > 0) return derived

  return fallbackCatalog()
}

async function testModelCompatibility(model, displayName, settings, options = {}) {
  const catalogVision = normalizeCatalogVisionCapability(options.catalogCapabilities?.vision)
  const probeMode = options.probeMode === "fast" ? "fast" : "full"
  const probeTimeoutMs = probeMode === "fast" ? REFRESH_PROBE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS
  const summary = {
    name: displayName,
    tested_at: new Date().toISOString(),
    status: "unknown",
    text: { ok: false, output_chars: 0 },
    image: {
      ok: false,
      output_chars: 0,
      source: catalogVision.supported === null ? "probe" : catalogVision.source,
    },
    reasoning: { ok: false, chars: 0 },
    tools: { ok: false, calls: 0 },
    capabilities: {
      vision: {
        supported: catalogVision.supported,
        source: catalogVision.source,
      },
      pdf: normalizeCatalogFileCapability(options.catalogCapabilities?.pdf),
      audio: normalizeCatalogFileCapability(options.catalogCapabilities?.audio),
      video: normalizeCatalogFileCapability(options.catalogCapabilities?.video),
    },
    notes: [],
  }

  try {
    const textRun = await callCommandCodeAlpha({
      messages: [{ role: "user", content: "Reply exactly: OK" }],
      stream: false,
      max_tokens: 64,
    }, model, settings, { timeoutMs: probeTimeoutMs })
    const text = collectText(textRun.events).trim()
    summary.text = { ok: text.length > 0, output_chars: text.length }
    if (!text.length) summary.notes.push("No devolvió texto en prompt mínimo.")
  } catch (error) {
    summary.notes.push(`Text error: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (catalogVision.supported !== null) {
    summary.image.ok = catalogVision.supported
    summary.capabilities.vision = {
      supported: catalogVision.supported,
      source: catalogVision.source,
    }
    if (catalogVision.supported === false) {
      summary.notes.push(`Catálogo marcó visión no soportada (${catalogVision.source}).`)
    }
  } else {
    try {
      const imageRun = await callCommandCodeAlpha({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image in one short sentence. If you cannot see it, say EXACTLY: NO_IMAGE_INPUT" },
              {
                type: "image_url",
                image_url: {
                  url: IMAGE_TEST_URL,
                },
              },
            ],
          },
        ],
        stream: false,
        max_tokens: 96,
      }, model, settings, { timeoutMs: probeTimeoutMs })
      const imageText = collectText(imageRun.events).trim()
      const lower = imageText.toLowerCase()
      const indicatesNoImage =
        lower.includes("no_image_input")
        || lower.includes("no veo ninguna imagen")
        || lower.includes("no image")
        || lower.includes("can't see")
        || lower.includes("cannot see")
        || lower.includes("didn't attach")
      const imageOk = imageText.length > 0 && !indicatesNoImage
      summary.image = {
        ok: imageOk,
        output_chars: imageText.length,
        source: "probe",
      }
      summary.capabilities.vision = {
        supported: imageOk,
        source: "probe",
      }
      if (!imageText.length) summary.notes.push("No devolvió texto útil para imagen.")
      if (indicatesNoImage) summary.notes.push("Respondió como si no hubiera imagen disponible.")
    } catch (error) {
      if (summary.capabilities.vision.supported === null) {
        summary.capabilities.vision = {
          supported: false,
          source: "probe_error",
        }
      }
      summary.notes.push(`Image error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (probeMode === "full") {
    try {
      const reasoningRun = await callCommandCodeAlpha({
        messages: [{ role: "user", content: "Think step by step and answer 17*19. Keep the final answer short." }],
        stream: false,
        max_tokens: 256,
      }, model, settings, { timeoutMs: probeTimeoutMs })
      const reasoning = collectReasoning(reasoningRun.events)
      summary.reasoning = { ok: reasoning.length > 0, chars: reasoning.length }
      if (!reasoning.length) summary.notes.push("No emitió reasoning visible.")
    } catch (error) {
      summary.notes.push(`Reasoning error: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    summary.notes.push("Reasoning probe omitido en modo fast.")
  }

  if (probeMode === "full") {
    try {
      const tool = {
        type: "function",
        function: {
          name: "echo",
          description: "Echo text",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      }
      const toolRun = await callCommandCodeAlpha({
        messages: [{ role: "user", content: "Use the echo tool with text hello and no other text." }],
        tools: [tool],
        tool_choice: "auto",
        stream: false,
        max_tokens: 128,
      }, model, settings, { timeoutMs: probeTimeoutMs })
      const toolCalls = collectToolCalls(toolRun.events)
      summary.tools = { ok: toolCalls.length > 0, calls: toolCalls.length }
      if (!toolCalls.length) summary.notes.push("No emitió tool calls.")
    } catch (error) {
      summary.notes.push(`Tools error: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    summary.notes.push("Tools probe omitido en modo fast.")
  }

  const capabilitySignals = probeMode === "full"
    ? [summary.text.ok, summary.image.ok, summary.reasoning.ok, summary.tools.ok]
    : [summary.text.ok, summary.image.ok]
  const capabilities = capabilitySignals.filter(Boolean).length
  const quotaBlocked = summary.notes.some(note => isInsufficientCreditsMessage(note))
  summary.status =
    quotaBlocked ? "quota_blocked"
    : probeMode === "full"
      ? capabilities >= 3 ? "ok" : capabilities > 0 ? "degraded" : "broken"
      : capabilities >= 2 ? "ok" : capabilities > 0 ? "degraded" : "broken"
    

  return summary
}

function resolveRefreshConcurrency(value, probeMode, modelCount) {
  if (probeMode === "catalog") {
    return 1
  }
  const fallback = probeMode === "full" ? 2 : 4
  const parsed = Number(value)
  const normalized = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
  return Math.max(1, Math.min(normalized, Math.max(1, modelCount)))
}

function buildCatalogOnlyCompatibilityEntry({ id, name, context_length, catalogCapabilities, previous }) {
  const contextWindow = resolveContextWindow(id, context_length)
  return {
    name,
    tested_at: previous?.tested_at || null,
    status: "catalog_only",
    text: previous?.text || { ok: null, output_chars: 0 },
    image: {
      ok: typeof catalogCapabilities?.vision?.supported === "boolean"
        ? catalogCapabilities.vision.supported
        : previous?.image?.ok ?? null,
      output_chars: previous?.image?.output_chars || 0,
      source: catalogCapabilities?.vision?.source || previous?.image?.source || null,
    },
    reasoning: previous?.reasoning || { ok: null, chars: 0 },
    tools: previous?.tools || { ok: null, calls: 0 },
    capabilities: mergeCapabilities(previous?.capabilities, {
      vision: normalizeCatalogVisionCapability(catalogCapabilities?.vision),
      pdf: normalizeCatalogFileCapability(catalogCapabilities?.pdf),
      audio: normalizeCatalogFileCapability(catalogCapabilities?.audio),
      video: normalizeCatalogFileCapability(catalogCapabilities?.video),
    }),
    notes: ["Catálogo sincronizado sin probes de disponibilidad."],
    context_length: contextWindow,
  }
}

function normalizeCatalogVisionCapability(vision) {
  if (!vision || typeof vision !== "object") {
    return { supported: null, source: null }
  }
  return {
    supported: typeof vision.supported === "boolean" ? vision.supported : null,
    source: typeof vision.source === "string" && vision.source.trim() ? vision.source.trim() : null,
  }
}

function normalizeCatalogFileCapability(fileCapability) {
  if (!fileCapability || typeof fileCapability !== "object") {
    return { supported: null, source: null }
  }
  return {
    supported: typeof fileCapability.supported === "boolean" ? fileCapability.supported : null,
    source: typeof fileCapability.source === "string" && fileCapability.source.trim() ? fileCapability.source.trim() : null,
  }
}

function mergeCapabilities(previous, next) {
  const prev = previous && typeof previous === "object" ? previous : {}
  const current = next && typeof next === "object" ? next : {}
  return {
    ...prev,
    ...current,
    vision: {
      ...(prev.vision && typeof prev.vision === "object" ? prev.vision : {}),
      ...(current.vision && typeof current.vision === "object" ? current.vision : {}),
    },
    pdf: {
      ...(prev.pdf && typeof prev.pdf === "object" ? prev.pdf : {}),
      ...(current.pdf && typeof current.pdf === "object" ? current.pdf : {}),
    },
    audio: {
      ...(prev.audio && typeof prev.audio === "object" ? prev.audio : {}),
      ...(current.audio && typeof current.audio === "object" ? current.audio : {}),
    },
    video: {
      ...(prev.video && typeof prev.video === "object" ? prev.video : {}),
      ...(current.video && typeof current.video === "object" ? current.video : {}),
    },
  }
}


function shouldPreservePreviousCompatibility(next, previous) {
  if (!previous || typeof previous !== "object") return false
  if (next?.status !== "quota_blocked") return false
  return ["ok", "degraded"].includes(String(previous.status || ""))
}

function isInsufficientCreditsMessage(text) {
  const normalized = String(text || "").toLowerCase()
  return normalized.includes("insufficient credits")
    || normalized.includes("purchase more credits")
    || normalized.includes("insufficient credit")
}

function buildModelDescriptor(model, compat) {
  const contextWindow = resolveContextWindow(model.id, model.context_length)
  const inputModalities = resolveInputModalities(compat)
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "ocg",
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
      vision: {
        supported: inputModalities.includes("image"),
        source: resolveVisionSource(compat),
      },
      pdf: {
        supported: supportsPdfHint(compat),
        source: resolvePdfSource(compat),
      },
      audio: {
        supported: supportsGenericCapability(compat, "audio"),
        source: resolveGenericCapabilitySource(compat, "audio"),
      },
      video: {
        supported: supportsGenericCapability(compat, "video"),
        source: resolveGenericCapabilitySource(compat, "video"),
      },
    },
    status: compat?.status || "unknown",
  }
}

function resolveInputModalities(compat) {
  const input = ["text"]
  if (supportsVisionInput(compat)) input.push("image")
  if (supportsPdfHint(compat) === true) input.push("pdf")
  if (supportsGenericCapability(compat, "audio") === true) input.push("audio")
  if (supportsGenericCapability(compat, "video") === true) input.push("video")
  return input
}

function supportsVisionInput(compat) {
  if (!compat || typeof compat !== "object") return false
  const vision = compat.capabilities?.vision
  if (vision && typeof vision === "object" && typeof vision.supported === "boolean") {
    return vision.supported
  }
  return compat?.image?.ok === true
}

function resolveVisionSource(compat) {
  const source = compat?.capabilities?.vision?.source
  return typeof source === "string" && source.trim() ? source.trim() : null
}

function supportsPdfHint(compat) {
  const supported = compat?.capabilities?.pdf?.supported
  return typeof supported === "boolean" ? supported : null
}

function resolvePdfSource(compat) {
  const source = compat?.capabilities?.pdf?.source
  return typeof source === "string" && source.trim() ? source.trim() : null
}

function supportsGenericCapability(compat, key) {
  const supported = compat?.capabilities?.[key]?.supported
  return typeof supported === "boolean" ? supported : null
}

function resolveGenericCapabilitySource(compat, key) {
  const source = compat?.capabilities?.[key]?.source
  return typeof source === "string" && source.trim() ? source.trim() : null
}

