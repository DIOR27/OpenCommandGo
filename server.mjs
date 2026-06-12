import { createServer } from "node:http"
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const PROJECT_DIR = "C:/Users/diego/OneDrive/Documentos/commandcode-go-shim"
const ENV_FILE = join(PROJECT_DIR, ".env.local")
const LOG_DIR = join(PROJECT_DIR, "logs")
const LOG_FILE = join(LOG_DIR, "shim.log")

loadEnvFile(ENV_FILE)

const HOST = process.env.SHIM_HOST || "127.0.0.1"
const PORT = Number(process.env.SHIM_PORT || "4310")
const COMMANDCODE_API_KEY = process.env.COMMANDCODE_API_KEY || ""
const COMMANDCODE_BASE_URL = (process.env.COMMANDCODE_BASE_URL || "https://api.commandcode.ai").replace(/\/+$/, "")
const COMMANDCODE_VERSION = process.env.COMMANDCODE_VERSION || "0.32.2"

const MODELS = [
  ["moonshotai/Kimi-K2.6", "Kimi K2.6"],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5"],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max"],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus"],
  ["Qwen/Qwen3.7-Max-Free", "Qwen 3.7 Max Free"],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3"],
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7"],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["zai-org/GLM-5.1", "GLM-5.1"],
  ["zai-org/GLM-5", "GLM-5"],
]

const MODEL_SET = new Set(MODELS.map(([id]) => id))

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

const server = createServer(async (req, res) => {
  try {
    addCors(res)

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        provider: "commandcode-go-shim",
        host: HOST,
        port: PORT,
        models: MODELS.map(([id, name]) => ({ id, name })),
      })
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: MODELS.map(([id]) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "commandcode-go-shim",
        })),
      })
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!COMMANDCODE_API_KEY) {
        return json(res, 500, openAIError("missing_api_key", "Falta COMMANDCODE_API_KEY en .env.local"))
      }

      const body = await readJson(req)
      if (!body || typeof body !== "object") {
        return json(res, 400, openAIError("invalid_request_error", "Body JSON inválido"))
      }

      const model = typeof body.model === "string" ? body.model.trim() : ""
      if (!MODEL_SET.has(model)) {
        return json(res, 400, openAIError("model_not_allowed", `Modelo no permitido: ${model || "(vacío)"}`))
      }

      const upstream = await callCommandCodeAlpha(body, model)
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

server.listen(PORT, HOST, () => {
  log(`LISTEN http://${HOST}:${PORT}`)
  console.log(`commandcode-go-shim listening on http://${HOST}:${PORT}`)
})

async function callCommandCodeAlpha(body, model) {
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

  const response = await fetch(`${COMMANDCODE_BASE_URL}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${COMMANDCODE_API_KEY}`,
      "x-cli-environment": "production",
      "x-command-code-version": COMMANDCODE_VERSION,
      "x-co-flag": "false",
      "x-project-slug": "opencode-commandcode-go-shim",
      "x-session-id": sessionId,
      "x-taste-learning": "false",
    },
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
      const content = []
      const text = messageText(message.content)
      if (text) content.push({ type: "text", text })

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

    const text = messageText(message.content)
    if (!text) continue
    converted.push({ role: "user", content: text })
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

function normalizeRole(role) {
  if (role === "assistant" || role === "user" || role === "tool") return role
  return role === "system" ? "system" : "user"
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
          content: toolCalls.length > 0 ? (text || null) : text,
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

function loadEnvFile(file) {
  if (!existsSync(file)) return
  const raw = readFileSync(file, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index === -1) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function openAIError(code, message) {
  return { error: { message, type: code } }
}

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
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
      if (body.length > 5 * 1024 * 1024) {
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
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
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
