import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { getPaths, ensureDir } from "../config/paths.js"
import { clearPid, getRuntimeSettings, readCompatibilityMatrix, writeCompatibilityMatrix, writePid } from "../config/store.js"
import { syncOpenCodeConfig } from "../opencode/config.js"
import { MODELS, MODEL_SET } from "../shared/models.js"
import { deriveCatalogFromCompatibility, extractModelRows, fallbackCatalog, normalizeCatalogRows } from "../shared/catalog.js"
import { normalizeCommandCodeReasoningEffort } from "../shared/commandcode-thinking.js"
import { resolveContextWindow } from "../shared/context-windows.js"
import { rotateLogIfNeeded } from "../shared/log-rotation.js"
import { t } from "../shared/i18n.js"

const IMAGE_TEST_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg"
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
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
          const upstream = await startCommandCodeAlphaStream(body, model, settings)
          return streamOpenAIResponse(res, model, upstream)
        }

        const upstream = await callCommandCodeAlpha(body, model, settings)
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

async function callCommandCodeAlpha(body, model, settings, options = {}) {
  const sessionId = randomUUID()
  const startedAt = Date.now()
  const payload = buildCommandCodePayload(body, model, sessionId)

  log(`REQUEST start session=${sessionId} model=${model} stream=${body.stream === true} messages=${payload.params.messages.length} tools=${payload.params.tools?.length || 0}`)

  const response = await fetchCommandCodeAlpha(payload, sessionId, settings, options)

  const raw = await response.text()
  if (!response.ok) {
    log(`UPSTREAM ${response.status} ${raw}`)
    throw new Error(t("error.upstream", response.status, raw.slice(0, 500)))
  }

  const events = parseEventLines(raw)
  const finishEvent = [...events].reverse().find(event =>
    ["finish", "done", "message_stop"].includes(String(event.type || event.event || "").toLowerCase()),
  ) || null
  const reasoning = collectReasoning(events)
  log(`REQUEST done session=${sessionId} model=${model} duration_ms=${Date.now() - startedAt} events=${events.length} reasoning_chars=${reasoning.length}`)

  return {
    events,
    finishReason: finishEvent?.finishReason ?? finishEvent?.finish_reason ?? finishEvent?.rawFinishReason ?? null,
    usage: extractUsage(finishEvent?.totalUsage ?? finishEvent?.total_usage ?? finishEvent?.usage ?? null),
    durationMs: Date.now() - startedAt,
    sessionId,
  }
}

async function startCommandCodeAlphaStream(body, model, settings) {
  const sessionId = randomUUID()
  const startedAt = Date.now()
  const payload = buildCommandCodePayload(body, model, sessionId)

  log(`REQUEST start session=${sessionId} model=${model} stream=true messages=${payload.params.messages.length} tools=${payload.params.tools?.length || 0}`)

  const response = await fetchCommandCodeAlpha(payload, sessionId, settings)
  if (!response.ok) {
    const raw = await response.text()
    log(`UPSTREAM ${response.status} ${raw}`)
    throw new Error(t("error.upstream", response.status, raw.slice(0, 500)))
  }
  if (!response.body) {
    throw new Error(t("error.upstream_no_body"))
  }

  return {
    sessionId,
    startedAt,
    responseBody: response.body,
  }
}

function buildCommandCodePayload(body, model, sessionId) {
  const messages = toCommandCodeMessages(body.messages)
  const tools = Array.isArray(body.tools) && body.tools.length > 0
    ? toCommandCodeTools(body.tools)
    : []
  const reasoningEffort = resolveReasoningEffort(body)

  return {
    mode: "custom-agent",
    config: buildEnvironmentContext(),
    memory: "",
    threadId: sessionId,
    params: {
      stream: true,
      model,
      max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 8192,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      messages,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(systemTextFromMessages(body.messages) ? { system: systemTextFromMessages(body.messages) } : {}),
    },
  }
}

function fetchCommandCodeAlpha(payload, sessionId, settings, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0
    ? options.timeoutMs
    : UPSTREAM_TIMEOUT_MS
  return fetch(`${settings.commandCodeBaseUrl}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.commandCodeApiKey}`,
      "x-cli-environment": "production",
      "x-command-code-version": settings.commandCodeVersion,
      "x-co-flag": "false",
      "x-project-slug": "opencode-ocg",
      "x-session-id": sessionId,
      "x-taste-learning": "false",
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(payload),
  })
}

function toCommandCodeMessages(messages) {
  if (!Array.isArray(messages)) return []

  const toolNames = new Map()
  const converted = []

  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const role = message.role

    if (role === "system") continue

    if (role === "assistant") {
      const content = toCommandCodeContentBlocks(message.content)

      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          const toolCallId = toolCall?.id || `toolu_${randomUUID()}`
          const toolName = toolCall?.function?.name || "tool"
          const input = parseJsonString(toolCall?.function?.arguments)
          toolNames.set(toolCallId, toolName)
          content.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input,
          })
        }
      }

      if (content.length > 0) {
        converted.push({ role: "assistant", content })
      }
      continue
    }

    if (role === "tool") {
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      const output = messageText(message.content) || jsonString(message.content)
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            ...(toolNames.get(toolCallId) ? { toolName: toolNames.get(toolCallId) } : {}),
            output: {
              type: "text",
              value: output,
            },
          },
        ],
      })
      continue
    }

    const blocks = toCommandCodeContentBlocks(message.content)
    if (!blocks.length) continue
    const hasOnlyText = blocks.every(block => block.type === "text")
    if (hasOnlyText) {
      const text = blocks.map(block => block.text || "").join("")
      if (!text) continue
      converted.push({ role: "user", content: text })
      continue
    }
    converted.push({ role: "user", content: blocks })
  }

  return ensureCacheControl(converted)
}

function toCommandCodeTools(tools) {
  return tools
    .map(tool => {
      if (!tool || typeof tool !== "object") return null
      if (tool.type !== "function" || !tool.function) return null
      return {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters || { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      }
    })
    .filter(Boolean)
}

function ensureCacheControl(messages) {
  const userIndexes = messages
    .map((message, index) => message.role === "user" ? index : -1)
    .filter(index => index >= 0)

  if (userIndexes.length < 2) return messages

  const targetIndex = userIndexes[userIndexes.length - 2]
  const target = messages[targetIndex]
  if (!target) return messages

  if (typeof target.content === "string") {
    target.content = [
      {
        type: "text",
        text: target.content,
        cache_control: { type: "ephemeral" },
      },
    ]
  }

  return messages
}

function systemTextFromMessages(messages) {
  if (!Array.isArray(messages)) return ""
  return messages
    .filter(message => message && typeof message === "object" && message.role === "system")
    .map(message => messageText(message.content))
    .filter(Boolean)
    .join("\n\n")
}

function messageText(content) {
  if (typeof content === "string") return content

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part
        if (!part || typeof part !== "object") return ""
        if (part.type === "text") return typeof part.text === "string" ? part.text : ""
        if (part.type === "input_text") return typeof part.text === "string" ? part.text : ""
        if (part.type === "output_text") return typeof part.text === "string" ? part.text : ""
        return ""
      })
      .join("")
  }

  return ""
}

function toCommandCodeContentBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }

  if (!Array.isArray(content)) return []

  const blocks = []
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part })
      continue
    }
    if (!part || typeof part !== "object") continue

    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      const text = typeof part.text === "string" ? part.text : ""
      if (text) blocks.push({ type: "text", text })
      continue
    }

    const imageBlock = normalizeImageBlock(part)
    if (imageBlock) {
      blocks.push(imageBlock)
    }
  }

  return blocks
}

function normalizeImageBlock(part) {
  if (!part || typeof part !== "object") return null

  if (part.type === "image" && part.source && typeof part.source === "object") {
    return { type: "image", source: part.source }
  }

  if (part.type === "image_url" && part.image_url) {
    const url = typeof part.image_url === "string"
      ? part.image_url
      : typeof part.image_url.url === "string"
        ? part.image_url.url
        : ""
    if (!url) return null
    const source = imageSourceFromUrl(url)
    return source ? { type: "image", source } : null
  }

  if (part.type === "input_image") {
    const url = typeof part.image_url === "string"
      ? part.image_url
      : typeof part.url === "string"
        ? part.url
        : ""
    if (!url) return null
    const source = imageSourceFromUrl(url)
    return source ? { type: "image", source } : null
  }

  return null
}

function imageSourceFromUrl(url) {
  if (typeof url !== "string" || !url) return null
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    return {
      type: "base64",
      media_type: match[1],
      data: match[2],
    }
  }

  return {
    type: "url",
    url,
  }
}

function parseEventLines(raw) {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.startsWith("data:") ? line.slice(5).trim() : line)
    .filter(line => line && line !== "[DONE]")
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function* readCommandCodeEventsFromStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let boundary = -1
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        const parsed = parseCommandCodeEventLine(line)
        if (parsed) yield parsed
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      const parsed = parseCommandCodeEventLine(buffer)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}

function parseCommandCodeEventLine(line) {
  const trimmed = String(line || "").trim()
  if (!trimmed) return null
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed
  if (!payload || payload === "[DONE]") return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function buildOpenAICompletion(model, upstream) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const text = collectText(upstream.events)
  const toolCalls = collectToolCalls(upstream.events)
  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : normalizeFinishReason(upstream.finishReason)
  const usage = normalizeUsage(upstream.usage)

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          content: toolCalls.length > 0
            ? (text || null)
            : text,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
    _meta: {
      shim: "ocg",
      duration_ms: upstream.durationMs,
      session_id: upstream.sessionId,
    },
  }
}

async function streamOpenAIResponse(res, model, upstream) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })

  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  })

  const toolCalls = new Map()
  let finishReason = "stop"
  let usage = null
  let sentText = false
  let toolIndex = 0

  try {
    for await (const event of readCommandCodeEventsFromStream(upstream.responseBody)) {
      const type = String(event.type || event.event || "").toLowerCase()

      if (type === "error") {
        throw new Error(t("error.upstream_stream", jsonString(event.error ?? event.message ?? event)))
      }

      if (type === "text-delta" || type === "text_delta" || type === "output_text_delta") {
        const text = eventText(event)
        if (!text) continue
        sentText = true
        writeSSE(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null,
            },
          ],
        })
        continue
      }

      if (type === "tool-call" || type === "tool_call") {
        const callId = event.toolCallId || event.tool_call_id || event.id || `call_${randomUUID()}`
        const callName = event.toolName || event.tool_name || event.name || "tool"
        const rawInput = event.input ?? event.args ?? event.arguments ?? {}
        const normalizedInput = typeof rawInput === "string" ? parseJsonString(rawInput) : rawInput
        const argumentString = jsonString(normalizedInput)
        toolCalls.set(callId, {
          id: callId,
          type: "function",
          function: {
            name: callName,
            arguments: argumentString,
          },
        })
        writeSSE(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: callId,
                    type: "function",
                    function: {
                      name: callName,
                      arguments: argumentString,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        toolIndex += 1
        continue
      }

      if (type === "finish" || type === "done" || type === "message_stop") {
        finishReason = toolCalls.size > 0
          ? "tool_calls"
          : normalizeFinishReason(event.finishReason ?? event.finish_reason ?? event.rawFinishReason)
        usage = normalizeUsage(extractUsage(event.totalUsage ?? event.total_usage ?? event.usage ?? null))
      }
    }
  } catch (error) {
    log(`STREAM ERROR session=${upstream.sessionId} model=${model} error=${error instanceof Error ? error.message : String(error)}`)
    finishReason = "stop"
  }

  if (!sentText && toolCalls.size === 0) {
    writeSSE(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "" },
          finish_reason: null,
        },
      ],
    })
  }

  writeSSE(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  })
  log(`REQUEST done session=${upstream.sessionId} model=${model} duration_ms=${Date.now() - upstream.startedAt} stream=true`)
  res.write("data: [DONE]\n\n")
  res.end()
}

function collectText(events) {
  return events.map(eventText).filter(Boolean).join("")
}

function collectReasoning(events) {
  let sawReasoning = false
  const parts = []

  for (const event of events) {
    const type = String(event.type || event.event || "").toLowerCase()
    if (type !== "reasoning-delta" && type !== "reasoning_delta") continue
    const piece = reasoningText(event)
    if (!piece) continue
    sawReasoning = true
    parts.push(piece)
  }

  return sawReasoning ? parts.join("") : ""
}

function collectToolCalls(events) {
  const calls = new Map()

  for (const event of events) {
    const type = String(event.type || event.event || "").toLowerCase()
    if (type !== "tool-call" && type !== "tool_call") continue

    const id = event.toolCallId || event.tool_call_id || event.id || `call_${randomUUID()}`
    const name = event.toolName || event.tool_name || event.name || "tool"
    const rawInput = event.input ?? event.args ?? event.arguments ?? {}
    const normalizedInput = typeof rawInput === "string" ? parseJsonString(rawInput) : rawInput
    const current = calls.get(id)

    if (!current) {
      calls.set(id, {
        id,
        type: "function",
        function: {
          name,
          arguments: jsonString(normalizedInput),
        },
      })
      continue
    }

    current.function.name = current.function.name || name
    current.function.arguments = mergeArgumentStrings(
      current.function.arguments,
      jsonString(normalizedInput),
    )
  }

  return Array.from(calls.values())
}

function eventText(event) {
  const type = String(event.type || event.event || "").toLowerCase()
  if (type !== "text-delta" && type !== "text_delta" && type !== "output_text_delta") {
    return ""
  }
  if (typeof event.text === "string") return event.text
  if (typeof event.delta === "string") return event.delta
  if (typeof event.content === "string") return event.content
  return ""
}

function reasoningText(event) {
  const type = String(event.type || event.event || "").toLowerCase()
  if (type !== "reasoning-delta" && type !== "reasoning_delta") {
    return ""
  }
  if (typeof event.thinking === "string") return event.thinking
  if (typeof event.text === "string") return event.text
  if (typeof event.delta === "string") return event.delta
  if (typeof event.content === "string") return event.content
  return ""
}

function normalizeFinishReason(reason) {
  const normalized = String(reason || "").toLowerCase()
  if (normalized.includes("length") || normalized.includes("max")) return "length"
  if (normalized.includes("tool")) return "tool_calls"
  return "stop"
}

function normalizeUsage(usage) {
  const prompt = numberOrZero(usage?.input_tokens)
  const completion = numberOrZero(usage?.output_tokens)
  const cachedRead = numberOrZero(usage?.cache_read_input_tokens)
  const cachedWrite = numberOrZero(usage?.cache_creation_input_tokens)
  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
  if (cachedRead > 0 || cachedWrite > 0) {
    result.prompt_tokens_details = {
      cached_tokens: cachedRead + cachedWrite,
    }
  }
  return result
}

function buildEnvironmentContext() {
  return {
    workingDir: homedir(),
    date: new Date().toISOString().slice(0, 10),
    environment: `node ${process.version}`,
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  }
}

function openAIError(code, message) {
  return { error: { message, type: code } }
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", chunk => {
      body += chunk
      if (body.length > MAX_REQUEST_BYTES) {
        req.destroy()
        reject(new Error("Body demasiado grande"))
      }
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function parseJsonString(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {}
  try {
    return JSON.parse(value)
  } catch {
    return { value }
  }
}

function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
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

function extractUsage(usage) {
  if (!usage || typeof usage !== "object") return null

  const input = numberOrZero(
    usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens,
  )
  const output = numberOrZero(
    usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens,
  )

  const details =
    objectOrNull(usage.inputTokenDetails)
    || objectOrNull(usage.input_token_details)
    || objectOrNull(usage.promptTokensDetails)
    || objectOrNull(usage.prompt_tokens_details)

  const cacheRead = numberOrZero(
    details?.cacheReadTokens
    ?? details?.cacheReadInputTokens
    ?? details?.cacheHitTokens
    ?? details?.cache_read_tokens
    ?? details?.cache_read_input_tokens
    ?? details?.cachedTokens
    ?? usage.cacheReadTokens
    ?? usage.cacheReadInputTokens
    ?? usage.cache_read_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cachedTokens
    ?? usage.cached_input_tokens,
  )

  const cacheWrite = numberOrZero(
    details?.cacheWriteTokens
    ?? details?.cacheWriteInputTokens
    ?? details?.cacheCreationTokens
    ?? details?.cacheCreationInputTokens
    ?? details?.cache_write_tokens
    ?? details?.cache_creation_tokens
    ?? usage.cacheWriteTokens
    ?? usage.cacheWriteInputTokens
    ?? usage.cacheCreationTokens
    ?? usage.cacheCreationInputTokens
    ?? usage.cache_write_tokens
    ?? usage.cache_creation_tokens
    ?? usage.cache_creation_input_tokens,
  )

  const noCacheInput = numberOrZero(
    details?.noCacheTokens
    ?? details?.no_cache_tokens
    ?? details?.uncachedTokens
    ?? details?.uncached_tokens
    ?? usage.noCacheTokens
    ?? usage.no_cache_tokens
    ?? usage.uncachedInputTokens
    ?? usage.uncached_input_tokens,
  )

  const normalizedInput = noCacheInput > 0
    ? noCacheInput
    : Math.max(0, input - cacheRead - cacheWrite)

  return {
    input_tokens: normalizedInput,
    output_tokens: output,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return "{}"
  }
}

function mergeArgumentStrings(current, incoming) {
  try {
    const currentParsed = parseJsonString(current)
    const incomingParsed = parseJsonString(incoming)
    return jsonString({
      ...(objectOrNull(currentParsed) || {}),
      ...(objectOrNull(incomingParsed) || {}),
    })
  } catch {
    return incoming || current || "{}"
  }
}

function summarizeIncomingMessages(messages) {
  if (!Array.isArray(messages)) return "messages=0"
  return messages.map((message, index) => {
    if (!message || typeof message !== "object") return `#${index}:invalid`
    if (typeof message.content === "string") {
      return `#${index}:${message.role || "unknown"}:text`
    }
    if (!Array.isArray(message.content)) {
      return `#${index}:${message.role || "unknown"}:unknown`
    }
    const kinds = message.content.map(part => {
      if (!part || typeof part !== "object") return "unknown"
      return part.type || "unknown"
    }).join(",")
    return `#${index}:${message.role || "unknown"}:[${kinds}]`
  }).join(" | ")
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

function requireShimAuth(req, res, settings) {
  const expected = String(settings.shimAccessToken || "").trim()
  if (!expected) {
    json(res, 500, openAIError("server_error", "Falta token interno del shim"))
    return false
  }

  const provided = getRequestShimToken(req)
  if (provided !== expected) {
    json(res, 401, openAIError("unauthorized", "Token del shim inválido o faltante"))
    return false
  }

  return true
}

function getRequestShimToken(req) {
  const direct = req.headers["x-ocg-token"]
  if (typeof direct === "string" && direct.trim()) return direct.trim()

  const authorization = req.headers.authorization
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (match?.[1]) return match[1].trim()
  }

  return ""
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase()
  return ["127.0.0.1", "localhost", "::1"].includes(normalized)
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

function resolveReasoningEffort(body) {
  const direct = normalizeCommandCodeReasoningEffort(body?.reasoning_effort)
  if (direct) return direct

  const nestedReasoning = normalizeCommandCodeReasoningEffort(body?.reasoning?.effort)
  if (nestedReasoning) return nestedReasoning

  const thinkingLevel = normalizeCommandCodeReasoningEffort(body?.thinkingLevel)
  if (thinkingLevel) return thinkingLevel

  const nestedThinkingLevel = normalizeCommandCodeReasoningEffort(body?.thinking?.thinkingLevel)
  if (nestedThinkingLevel) return nestedThinkingLevel

  return null
}
