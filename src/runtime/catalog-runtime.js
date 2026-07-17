import { syncOpenCodeConfig } from "../opencode/config.js"
import { deriveCatalogFromCompatibility, extractModelRows, fallbackCatalog, normalizeCatalogRows } from "../shared/catalog.js"
import { supportsCommandCodeReasoning } from "../shared/commandcode-thinking.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { COMMANDCODE_PROVIDER, comparableCommandCodeModel, providerlessCommandCodeModel, resolveBridgeCapabilities, resolveBridgeInputModalities } from "../shared/models.js"
import { callCommandCodeAlpha, collectReasoning, collectText, collectToolCalls } from "./chat-bridge.js"
import { buildCmdCatalogRows, fetchCmdModelList, parseCmdModelList, resolveCmdBinary } from "../shared/commandcode-cmd-catalog.js"
import { readResolvedProvidersFromSidecar } from "../opencode/sidecar-resolved-providers.js"

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
    async syncProviderConfig(settings) {
      await syncOpenCodeConfig({
        host: settings.host,
        port: settings.port,
        providers: [
          {
            id: settings.providerId,
            kind: "commandcode",
            routePrefix: COMMANDCODE_PROVIDER.routePrefix,
            name: COMMANDCODE_PROVIDER.name,
            compatibilityMatrix,
          },
        ],
        createIfMissing: true,
      })
    },
    async promoteModelVision(modelId, settings) {
      let mutated = false
      const entry = compatibilityMatrix?.models?.[modelId]
      if (!entry) return false

      if (!entry.capabilities?.vision?.supported) {
        if (!entry.image) entry.image = { ok: false, output_chars: 0, source: null }
        entry.image.ok = true
        entry.image.source = "runtime_upgrade"
        if (!entry.capabilities) entry.capabilities = {}
        entry.capabilities.vision = { supported: true, source: "runtime_upgrade" }
        mutated = true
      }

      if (!mutated) return false

      writeCompatibilityMatrix(compatibilityMatrix)
      availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)
      await this.syncProviderConfig(settings)
      log(`MODEL_UPGRADE model=${modelId} action=promote_vision source=runtime_upgrade`)
      return true
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
        provider: "commandcode",
        type: "catalog",
        message: "consultando modelos...",
      })
      const catalog = await fetchAvailableCatalog(settings)
      options.onProgress?.({
        provider: "commandcode",
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
        await syncOpenCodeConfig({
          host: settings.host,
          port: settings.port,
          providers: [
            {
              id: settings.providerId,
              kind: "commandcode",
              routePrefix: COMMANDCODE_PROVIDER.routePrefix,
              name: COMMANDCODE_PROVIDER.name,
              compatibilityMatrix,
            },
          ],
          createIfMissing: true,
        })
        log(`COMPAT refresh_done models=${Object.keys(next.models).length} mode=catalog`)
        return compatibilityMatrix
      }

      let nextIndex = 0

      const runOne = async rowIndex => {
        const row = catalog[rowIndex]
        const { id, name, context_length, catalog_capabilities, tags } = row
        options.onProgress?.({
          provider: "commandcode",
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
            provider: "commandcode",
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
          provider: "commandcode",
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
      await syncOpenCodeConfig({
        host: settings.host,
        port: settings.port,
        providers: [
          {
            id: settings.providerId,
            kind: "commandcode",
            routePrefix: COMMANDCODE_PROVIDER.routePrefix,
            name: COMMANDCODE_PROVIDER.name,
            compatibilityMatrix,
          },
        ],
        createIfMissing: true,
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
    // PRIMARY: try cmd --list-models first
    let cmdRows = []
    let cmdSourced = false
    try {
      const cmdPath = resolveCmdBinary()
      if (cmdPath) {
        log(`CATALOG cmd_binary=${cmdPath}`)
        const stdout = await fetchCmdModelList({ cmdPath, timeoutMs: 10000 })
        const parsed = parseCmdModelList(stdout)
        cmdRows = buildCmdCatalogRows(parsed, { filterSection: "Open Source" })
        if (cmdRows.length > 0) {
          cmdSourced = true
          log(`CATALOG cmd_source models=${cmdRows.length}`)
        }
      }
    } catch (error) {
      log(`CATALOG cmd_error ${error instanceof Error ? error.message : String(error)}`)
    }

    // Enrich cmd-sourced rows with context_length from HTTP API
    if (cmdSourced) {
      try {
        const apiRows = await fetchHttpApiModels(settings, { timeoutMs: 6000 })
        if (apiRows.length > 0) {
          const contextLookup = new Map(apiRows.filter(r => r.context_length > 0).map(r => [r.id, r.context_length]))
          let enriched = 0
          for (const row of cmdRows) {
            const apiContext = contextLookup.get(row.id)
            if (apiContext && (!row.context_length || row.context_length < apiContext)) {
              row.context_length = apiContext
              enriched++
            }
          }
          log(`CATALOG context_enriched from_api=${enriched}`)
        }
      } catch {
        // context enrichment failed, cmd context is already reasonable
      }

      // Enrich cmd-sourced rows with capabilities from OpenCode Desktop sidecar
      try {
        const sidecarResult = await readResolvedProvidersFromSidecar({ timeoutMs: 2000 })
        if (sidecarResult.ok && Object.keys(sidecarResult.providers).length > 0) {
          // Build normalized lookup across all providers, including providerless fallback
          const sidecarModels = new Map()
          for (const provider of Object.values(sidecarResult.providers)) {
            if (!provider.models) continue
            for (const [rawId, entry] of Object.entries(provider.models)) {
              const normalized = comparableCommandCodeModel(rawId)
              sidecarModels.set(normalized, entry)
              const providerless = providerlessCommandCodeModel(rawId)
              if (providerless !== normalized) sidecarModels.set(providerless, entry)
            }
          }

          let enriched = 0
          for (const row of cmdRows) {
            const normalizedCmdId = comparableCommandCodeModel(row.id)
            let match = sidecarModels.get(normalizedCmdId)
            if (!match) {
              match = sidecarModels.get(providerlessCommandCodeModel(row.id))
            }
            if (match) {
              const caps = match.capabilities
              if (caps && typeof caps === "object") {
                if (!row.catalog_capabilities) row.catalog_capabilities = {}
                if (caps.vision && caps.vision.supported !== undefined && caps.vision.supported !== null) {
                  row.catalog_capabilities.vision = { supported: caps.vision.supported, source: "sidecar" }
                }
                if (caps.pdf && caps.pdf.supported !== undefined && caps.pdf.supported !== null) {
                  row.catalog_capabilities.pdf = { supported: caps.pdf.supported, source: "sidecar" }
                }
                if (caps.audio && caps.audio.supported !== undefined && caps.audio.supported !== null) {
                  row.catalog_capabilities.audio = { supported: caps.audio.supported, source: "sidecar" }
                }
                if (caps.video && caps.video.supported !== undefined && caps.video.supported !== null) {
                  row.catalog_capabilities.video = { supported: caps.video.supported, source: "sidecar" }
                }
                if (caps.reasoning && caps.reasoning.supported !== undefined && caps.reasoning.supported !== null) {
                  row.catalog_capabilities.reasoning = { supported: caps.reasoning.supported, source: "sidecar" }
                }
              }

              // Reconstruct modalities.input based on merged capabilities
              const modalities = row.modalities || (row.modalities = {})
              const input = modalities.input ? [...modalities.input] : ["text"]
              const cc = row.catalog_capabilities
              if (cc.vision?.supported === true && !input.includes("image")) input.push("image")
              if (cc.pdf?.supported === true && !input.includes("pdf")) input.push("pdf")
              if (cc.audio?.supported === true && !input.includes("audio")) input.push("audio")
              if (cc.video?.supported === true && !input.includes("video")) input.push("video")
              modalities.input = input

              enriched++
            }
          }
          if (enriched > 0) log(`CATALOG sidecar_enriched models=${enriched}`)
        }
      } catch {
        // sidecar enrichment failed silently, cmd rows keep current values
      }

      return cmdRows
    }

	// FALLBACK 1: HTTP API /provider/v1/models
	const apiRows = await fetchHttpApiModels(settings)
	if (apiRows.length > 0) return apiRows

	// FALLBACK 2: derive from existing compatibility matrix
	const derived = deriveCatalogFromCompatibility(compatibilityMatrix)
	if (derived.length > 0) return derived

	// FALLBACK 3: hardcoded fallback catalog
	return fallbackCatalog()
  }
}

async function fetchHttpApiModels(settings, { timeoutMs = 8000 } = {}) {
  try {
    const response = await fetch(`${settings.commandCodeBaseUrl}/provider/v1/models`, {
      headers: {
        Authorization: `Bearer ${settings.commandCodeApiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(String(response.status))
    const data = await response.json()
    return normalizeCatalogRows(extractModelRows(data))
  } catch {
    return []
  }
}

function buildModelDescriptor(model, compat) {
  const contextWindow = resolveContextWindow(model.id, model.context_length)
  const inputModalities = resolveInputModalities(compat)
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: COMMANDCODE_PROVIDER.id,
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
    capabilities: resolveBridgeCapabilities(compat),
    ...(supportsCommandCodeReasoning(model.id, compat?.tags) || compat?.capabilities?.reasoning?.supported === true
      ? { reasoning: true }
      : {}),
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
    audio: { ok: false, output_chars: 0, source: null },
    video: { ok: false, output_chars: 0, source: null },
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

  // Audio probe — only in full mode
  if (probeMode === "full") {
    const catalogAudio = normalizeCatalogFileCapability(options.catalogCapabilities?.audio)
    if (catalogAudio.supported !== null) {
      summary.audio.ok = catalogAudio.supported
      summary.capabilities.audio = {
        supported: catalogAudio.supported,
        source: catalogAudio.source,
      }
      if (catalogAudio.supported === false) {
        summary.notes.push(`Catálogo marcó audio no soportado (${catalogAudio.source}).`)
      }
    } else {
      try {
        const audioRun = await callCommandCodeAlpha({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Reply OK if you can process this message." },
                { type: "input_audio", audio: { data: "placeholder" } },
              ],
            },
          ],
          stream: false,
          max_tokens: 64,
        }, model, settings, { timeoutMs: probeTimeoutMs })
        const audioText = collectText(audioRun.events).trim()
        const audioOk = audioText.length > 0
        summary.audio = { ok: audioOk, output_chars: audioText.length, source: "probe" }
        summary.capabilities.audio = { supported: audioOk, source: "probe" }
        if (!audioText.length) summary.notes.push("Audio probe: no devolvió texto.")
      } catch (error) {
        summary.audio = { ok: false, output_chars: 0, source: "probe_error" }
        summary.capabilities.audio = { supported: false, source: "probe_error" }
        summary.notes.push(`Audio error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Video probe — only in full mode
  if (probeMode === "full") {
    const catalogVideo = normalizeCatalogFileCapability(options.catalogCapabilities?.video)
    if (catalogVideo.supported !== null) {
      summary.video.ok = catalogVideo.supported
      summary.capabilities.video = {
        supported: catalogVideo.supported,
        source: catalogVideo.source,
      }
      if (catalogVideo.supported === false) {
        summary.notes.push(`Catálogo marcó video no soportado (${catalogVideo.source}).`)
      }
    } else {
      try {
        const videoRun = await callCommandCodeAlpha({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Reply OK if you can process this message." },
                { type: "input_video", video: { data: "placeholder" } },
              ],
            },
          ],
          stream: false,
          max_tokens: 64,
        }, model, settings, { timeoutMs: probeTimeoutMs })
        const videoText = collectText(videoRun.events).trim()
        const videoOk = videoText.length > 0
        summary.video = { ok: videoOk, output_chars: videoText.length, source: "probe" }
        summary.capabilities.video = { supported: videoOk, source: "probe" }
        if (!videoText.length) summary.notes.push("Video probe: no devolvió texto.")
      } catch (error) {
        summary.video = { ok: false, output_chars: 0, source: "probe_error" }
        summary.capabilities.video = { supported: false, source: "probe_error" }
        summary.notes.push(`Video error: ${error instanceof Error ? error.message : String(error)}`)
      }
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
    ? [summary.text.ok, summary.image.ok, summary.reasoning.ok, summary.tools.ok, summary.audio.ok, summary.video.ok]
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

export function buildCatalogOnlyCompatibilityEntry({ id, name, tags, context_length, catalogCapabilities, previous }) {
  const contextWindow = resolveContextWindow(id, context_length)
  const previousVision = previous?.capabilities?.vision
  const previousVisionTrusted =
    previousVision?.supported === true &&
    typeof previousVision.source === "string" &&
    !previousVision.source.includes("fallback")
  const catalogVision = normalizeCatalogVisionCapability(catalogCapabilities?.vision)
  const vision = previousVisionTrusted && catalogVision.supported !== false
    ? { supported: true, source: previousVision.source }
    : catalogVision
  return {
    name,
    tags: Array.isArray(tags) ? tags : (previous?.tags || []),
    tested_at: previous?.tested_at || null,
    status: "catalog_only",
    text: previous?.text || { ok: null, output_chars: 0 },
    image: {
      ok: typeof catalogCapabilities?.vision?.supported === "boolean"
        ? catalogCapabilities.vision.supported
        : inheritImageOk(previous?.image),
      output_chars: previous?.image?.output_chars || 0,
      source: catalogCapabilities?.vision?.source || previous?.image?.source || null,
    },
    reasoning: previous?.reasoning || { ok: null, chars: 0 },
    tools: previous?.tools || { ok: null, calls: 0 },
    capabilities: mergeCapabilities(previous?.capabilities, {
      vision,
      pdf: normalizeCatalogFileCapability(catalogCapabilities?.pdf),
      audio: normalizeCatalogFileCapability(catalogCapabilities?.audio),
      video: normalizeCatalogFileCapability(catalogCapabilities?.video),
      reasoning: normalizeCatalogFileCapability(catalogCapabilities?.reasoning),
    }),
    notes: ["Catálogo sincronizado sin probes de disponibilidad."],
    context_length: contextWindow,
  }
}

function inheritImageOk(previousImage) {
  if (!previousImage || typeof previousImage !== "object") return null
  if (typeof previousImage.ok !== "boolean") return null
  const source = typeof previousImage.source === "string" ? previousImage.source : ""
  if (source.includes("fallback_registry") || source.includes("fallback")) return null
  return previousImage.ok
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
  return resolveBridgeInputModalities(compat)
}
