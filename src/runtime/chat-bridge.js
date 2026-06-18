import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { normalizeCommandCodeReasoningEffort } from "../shared/commandcode-thinking.js"
import { t } from "../shared/i18n.js"
import { writeSSE } from "./http-utils.js"

const UPSTREAM_TIMEOUT_MS = 120000

export async function callCommandCodeAlpha(body, model, settings, options = {}) {
  const sessionId = randomUUID()
  const startedAt = Date.now()
  const payload = buildCommandCodePayload(body, model, sessionId)

  options.log?.(`REQUEST start session=${sessionId} model=${model} stream=${body.stream === true} messages=${payload.params.messages.length} tools=${payload.params.tools?.length || 0}`)

  const response = await fetchCommandCodeAlpha(payload, sessionId, settings, options)

  const raw = await response.text()
  if (!response.ok) {
    options.log?.(`UPSTREAM ${response.status} ${raw}`)
    throw new Error(t("error.upstream", response.status, raw.slice(0, 500)))
  }

  const events = parseEventLines(raw)
  const finishEvent = [...events].reverse().find(event =>
    ["finish", "done", "message_stop"].includes(String(event.type || event.event || "").toLowerCase()),
  ) || null
  const reasoning = collectReasoning(events)
  options.log?.(`REQUEST done session=${sessionId} model=${model} duration_ms=${Date.now() - startedAt} events=${events.length} reasoning_chars=${reasoning.length}`)

  return {
    events,
    finishReason: finishEvent?.finishReason ?? finishEvent?.finish_reason ?? finishEvent?.rawFinishReason ?? null,
    usage: extractUsage(finishEvent?.totalUsage ?? finishEvent?.total_usage ?? finishEvent?.usage ?? null),
    durationMs: Date.now() - startedAt,
    sessionId,
  }
}

export async function startCommandCodeAlphaStream(body, model, settings, options = {}) {
  const sessionId = randomUUID()
  const startedAt = Date.now()
  const payload = buildCommandCodePayload(body, model, sessionId)

  options.log?.(`REQUEST start session=${sessionId} model=${model} stream=true messages=${payload.params.messages.length} tools=${payload.params.tools?.length || 0}`)

  const response = await fetchCommandCodeAlpha(payload, sessionId, settings, options)
  if (!response.ok) {
    const raw = await response.text()
    options.log?.(`UPSTREAM ${response.status} ${raw}`)
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

export function buildOpenAICompletion(model, upstream) {
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
      shim: "opencg-cli",
      duration_ms: upstream.durationMs,
      session_id: upstream.sessionId,
    },
  }
}

export async function streamOpenAIResponse(res, model, upstream, options = {}) {
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
    options.log?.(`STREAM ERROR session=${upstream.sessionId} model=${model} error=${error instanceof Error ? error.message : String(error)}`)
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
  options.log?.(`REQUEST done session=${upstream.sessionId} model=${model} duration_ms=${Date.now() - upstream.startedAt} stream=true`)
  res.write("data: [DONE]\n\n")
  res.end()
}

export function collectText(events) {
  return events.map(eventText).filter(Boolean).join("")
}

export function collectReasoning(events) {
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

export function collectToolCalls(events) {
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

export function summarizeIncomingMessages(messages) {
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

export function extractUsage(usage) {
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
