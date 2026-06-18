import { syncOpenCodeConfig } from "../opencode/config.js"
import { deriveCatalogFromCompatibility, extractModelRows, fallbackCatalog, normalizeCatalogRows } from "../shared/catalog.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { t } from "../shared/i18n.js"
import { callCommandCodeAlpha, collectReasoning, collectText, collectToolCalls } from "./chat-bridge.js"

const IMAGE_TEST_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg"
const UPSTREAM_TIMEOUT_MS = 120000
const REFRESH_PROBE_TIMEOUT_MS = 25000

export function createCatalogController({ initialCompatibilityMatrix, writeCompatibilityMatrix, log }) {
  let compatibilityMatrix = initialCompatibilityMatrix
  let availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
  let compatibilityRefreshRunning = false

  return {
    getCompatibilityMatrix: () => compatibilityMatrix,
    getAvailableCatalog: () => availableCatalog,
    buildModelList: () => availableCatalog.map(model => buildModelDescriptor(model, compatibilityMatrix?.models?.[model.id])),
    syncProviderConfig(settings) {
      syncOpenCodeConfig({
        providerId: settings.providerId,
        host: settings.host,
        port: settings.port,
        compatibilityMatrix,
      })
    },
    async refreshNow(settings, options = {}) {
      const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
      return await maybeRefreshCompatibility("manual", refreshMs, settings, {
        force: true,
        probeMode: options.probeMode || "catalog",
        verifyAvailability: options.verifyAvailability === true,
        concurrency: options.concurrency,
        onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
      })
    },
    schedule(settings) {
      const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
      void maybeRefreshCompatibility("startup-force", refreshMs, settings)
      setInterval(() => {
        void maybeRefreshCompatibility("interval", refreshMs, settings)
      }, refreshMs)
    },
  }

  async function maybeRefreshCompatibility(reason, refreshMs, settings, options = {}) {
    if (compatibilityRefreshRunning) return compatibilityMatrix
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
          const { id, name, context_length, catalog_capabilities, tags } = row
          const previous = compatibilityMatrix?.models?.[id]
          next.models[id] = buildCatalogOnlyCompatibilityEntry({
            id,
            name,
            tags,
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
        const { id, name, context_length, catalog_capabilities, tags } = row
        options.onProgress?.({
          type: "model-start",
          index: rowIndex + 1,
          total: catalog.length,
          model: id,
        })

        const tested = await testModelCompatibility(id, name, settings, {
          catalogCapabilities: catalog_capabilities,
          tags,
          probeMode,
        })
        tested.context_length = resolveContextWindow(id, context_length)
        const previous = compatibilityMatrix?.models?.[id]

        if (shouldPreservePreviousCompatibility(tested, previous)) {
          next.models[id] = {
            ...previous,
            name,
            tags,
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

      await Promise.all(Array.from({ length: concurrency }, () => worker()))

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

async function testModelCompatibility(model, displayName, settings, options = {}) {
  const catalogVision = normalizeCatalogVisionCapability(options.catalogCapabilities?.vision)
  const catalogReasoning = normalizeCatalogFileCapability(options.catalogCapabilities?.reasoning)
  const probeMode = options.probeMode === "fast" ? "fast" : "full"
  const probeTimeoutMs = probeMode === "fast" ? REFRESH_PROBE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS
  const summary = {
    name: displayName,
    tags: Array.isArray(options.tags) ? options.tags : [],
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
      reasoning: catalogReasoning,
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
                image_url: { url: IMAGE_TEST_URL },
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
      const reasoningOk = reasoning.length > 0
      summary.reasoning = { ok: reasoningOk, chars: reasoning.length }
      if (reasoningOk) {
        summary.capabilities.reasoning = {
          supported: true,
          source: summary.capabilities.reasoning?.source || "probe",
        }
      }
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
  if (probeMode === "catalog") return 1
  const fallback = probeMode === "full" ? 2 : 4
  const parsed = Number(value)
  const normalized = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
  return Math.max(1, Math.min(normalized, Math.max(1, modelCount)))
}

function buildCatalogOnlyCompatibilityEntry({ id, name, tags, context_length, catalogCapabilities, previous }) {
  const contextWindow = resolveContextWindow(id, context_length)
  return {
    name,
    tags: Array.isArray(tags) ? tags : (previous?.tags || []),
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
      reasoning: normalizeCatalogFileCapability(catalogCapabilities?.reasoning),
    }),
    notes: ["Catálogo sincronizado sin probes de disponibilidad."],
    context_length: contextWindow,
  }
}

function normalizeCatalogVisionCapability(vision) {
  if (!vision || typeof vision !== "object") return { supported: null, source: null }
  return {
    supported: typeof vision.supported === "boolean" ? vision.supported : null,
    source: typeof vision.source === "string" && vision.source.trim() ? vision.source.trim() : null,
  }
}

function normalizeCatalogFileCapability(fileCapability) {
  if (!fileCapability || typeof fileCapability !== "object") return { supported: null, source: null }
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
