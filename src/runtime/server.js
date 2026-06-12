import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { getPaths, ensureDir } from "../config/paths.js"
import { clearPid, getRuntimeSettings, readCompatibilityMatrix, writeCompatibilityMatrix, writePid } from "../config/store.js"
import { syncOpenCodeConfig } from "../opencode/config.js"
import { MODELS, MODEL_SET } from "../shared/models.js"
import { deriveCatalogFromCompatibility, extractModelRows, fallbackCatalog, normalizeCatalogRows } from "../shared/catalog.js"

const IMAGE_TEST_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg"
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 120000

let compatibilityMatrix = readCompatibilityMatrix()
let compatibilityRefreshRunning = false
let currentServer = null
let availableCatalog = deriveCatalogFromCompatibility(compatibilityMatrix)

export async function refreshModelCatalogNow() {
  const settings = getRuntimeSettings()
  const refreshMs = settings.compatibilityRefreshHours * 60 * 60 * 1000
  return await maybeRefreshCompatibility("manual", refreshMs, settings, { force: true })
}

export async function startServer() {
  if (currentServer) return currentServer

  const settings = getRuntimeSettings()
  if (!settings.allowRemoteHost && !isLoopbackHost(settings.host)) {
    throw new Error(`Host no permitido para uso local: ${settings.host}. Usá 127.0.0.1 o localhost.`)
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
          provider: "commandcode-go-shim",
          host: settings.host,
          port: settings.port,
          models: availableCatalog.map(({ id, name }) => ({ id, name })),
          compatibility_updated_at: compatibilityMatrix.updated_at || null,
        })
      }

      if (req.method === "GET" && url.pathname === "/compatibility") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, compatibilityMatrix)
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          object: "list",
          data: availableCatalog.map(model => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "commandcode-go-shim",
            name: model.name,
            context_length: model.context_length,
          })),
        })
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!requireShimAuth(req, res, settings)) return
        if (!settings.commandCodeApiKey) {
          return json(res, 500, openAIError("missing_api_key", `Falta API key. Corré: ccga setup o ccga set-api-key`))
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

        const upstream = await callCommandCodeAlpha(body, model, settings)
        if (body.stream === true) {
          return streamOpenAIResponse(res, model, upstream)
        }

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
  console.log(`commandcode-go-shim listening on http://${settings.host}:${settings.port}`)
  scheduleCompatibilityRefresh(refreshMs, settings)
  return server
}

async function callCommandCodeAlpha(body, model, settings) {
  const sessionId = randomUUID()
  const startedAt = Date.now()
  const messages = toCommandCodeMessages(body.messages)
  const tools = Array.isArray(body.tools) && body.tools.length > 0
    ? toCommandCodeTools(body.tools)
    : []
  const payload = {
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
      ...(tools.length > 0 ? { tools } : {}),
      ...(systemTextFromMessages(body.messages) ? { system: systemTextFromMessages(body.messages) } : {}),
    },
  }

  log(`REQUEST start session=${sessionId} model=${model} stream=${body.stream === true} messages=${messages.length} tools=${tools.length}`)

  const response = await fetch(`${settings.commandCodeBaseUrl}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.commandCodeApiKey}`,
      "x-cli-environment": "production",
      "x-command-code-version": settings.commandCodeVersion,
      "x-co-flag": "false",
      "x-project-slug": "opencode-commandcode-go-shim",
      "x-session-id": sessionId,
      "x-taste-learning": "false",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    body: JSON.stringify(payload),
  })

  const raw = await response.text()
  if (!response.ok) {
    log(`UPSTREAM ${response.status} ${raw}`)
    throw new Error(`Command Code respondió ${response.status}: ${raw.slice(0, 500)}`)
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
      shim: "commandcode-go-shim",
      duration_ms: upstream.durationMs,
      session_id: upstream.sessionId,
    },
  }
}

function streamOpenAIResponse(res, model, upstream) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = collectToolCalls(upstream.events)
  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : normalizeFinishReason(upstream.finishReason)

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

  let sentText = false
  for (const event of upstream.events) {
    const type = String(event.type || event.event || "").toLowerCase()
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
    }
  }

  if (toolCalls.length > 0) {
    toolCalls.forEach((toolCall, index) => {
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
                  index,
                  id: toolCall.id,
                  type: "function",
                  function: {
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    })
  }

  if (!sentText && toolCalls.length === 0) {
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
    usage: normalizeUsage(upstream.usage),
  })
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
    const catalog = await fetchAvailableCatalog(settings)
    const next = {
      updated_at: new Date().toISOString(),
      refresh_interval_hours: settings.compatibilityRefreshHours,
      models: {},
    }

    for (const { id, name, context_length } of catalog) {
      const tested = await testModelCompatibility(id, name, settings)
      tested.context_length = context_length
      const previous = compatibilityMatrix?.models?.[id]
      if (shouldPreservePreviousCompatibility(tested, previous)) {
        next.models[id] = {
          ...previous,
          name,
          context_length,
          tested_at: tested.tested_at,
          last_probe_status: tested.status,
          last_probe_notes: tested.notes,
        }
        continue
      }
      next.models[id] = tested
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
    if (!response.ok) throw new Error(`models ${response.status}`)
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

async function testModelCompatibility(model, displayName, settings) {
  const summary = {
    name: displayName,
    tested_at: new Date().toISOString(),
    status: "unknown",
    text: { ok: false, output_chars: 0 },
    image: { ok: false, output_chars: 0 },
    reasoning: { ok: false, chars: 0 },
    tools: { ok: false, calls: 0 },
    notes: [],
  }

  try {
    const textRun = await callCommandCodeAlpha({
      messages: [{ role: "user", content: "Reply exactly: OK" }],
      stream: false,
      max_tokens: 64,
    }, model, settings)
    const text = collectText(textRun.events).trim()
    summary.text = { ok: text.length > 0, output_chars: text.length }
    if (!text.length) summary.notes.push("No devolvió texto en prompt mínimo.")
  } catch (error) {
    summary.notes.push(`Text error: ${error instanceof Error ? error.message : String(error)}`)
  }

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
    }, model, settings)
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
    summary.image = { ok: imageOk, output_chars: imageText.length }
    if (!imageText.length) summary.notes.push("No devolvió texto útil para imagen.")
    if (indicatesNoImage) summary.notes.push("Respondió como si no hubiera imagen disponible.")
  } catch (error) {
    summary.notes.push(`Image error: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const reasoningRun = await callCommandCodeAlpha({
      messages: [{ role: "user", content: "Think step by step and answer 17*19. Keep the final answer short." }],
      stream: false,
      max_tokens: 256,
    }, model, settings)
    const reasoning = collectReasoning(reasoningRun.events)
    summary.reasoning = { ok: reasoning.length > 0, chars: reasoning.length }
    if (!reasoning.length) summary.notes.push("No emitió reasoning visible.")
  } catch (error) {
    summary.notes.push(`Reasoning error: ${error instanceof Error ? error.message : String(error)}`)
  }

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
    }, model, settings)
    const toolCalls = collectToolCalls(toolRun.events)
    summary.tools = { ok: toolCalls.length > 0, calls: toolCalls.length }
    if (!toolCalls.length) summary.notes.push("No emitió tool calls.")
  } catch (error) {
    summary.notes.push(`Tools error: ${error instanceof Error ? error.message : String(error)}`)
  }

  const capabilities = [summary.text.ok, summary.image.ok, summary.reasoning.ok, summary.tools.ok].filter(Boolean).length
  const quotaBlocked = summary.notes.some(note => isInsufficientCreditsMessage(note))
  summary.status =
    quotaBlocked ? "quota_blocked"
    : capabilities >= 3 ? "ok"
    : capabilities > 0 ? "degraded"
    : "broken"

  return summary
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
  const direct = req.headers["x-commandcode-shim-token"]
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
