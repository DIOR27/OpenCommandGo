const UPSTREAM_TIMEOUT_MS = 120000

export async function callOpenRouter(body, settings) {
  const payload = buildOpenRouterPayload(body)
  const response = await fetch(`${settings.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: buildOpenRouterHeaders(settings),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    body: JSON.stringify(payload),
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`OpenRouter respondió ${response.status}: ${raw.slice(0, 500)}`)
  }

  return JSON.parse(raw)
}

export async function startOpenRouterStream(body, settings) {
  const payload = buildOpenRouterPayload({
    ...body,
    stream: true,
  })
  const response = await fetch(`${settings.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: buildOpenRouterHeaders(settings),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const raw = await response.text()
    throw new Error(`OpenRouter respondió ${response.status}: ${raw.slice(0, 500)}`)
  }
  if (!response.body) {
    throw new Error("OpenRouter no devolvió un body de streaming")
  }

  return response
}

export async function pipeOpenRouterStream(res, upstreamResponse) {
  res.writeHead(200, {
    "Content-Type": upstreamResponse.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })

  const reader = upstreamResponse.body.getReader()
  try {
    while (true) {
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        break
      }
      const { done, value } = chunk
      if (done) break
      try {
        res.write(value)
      } catch {
        break
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
    try {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n")
      }
    } catch {
      // ignore
    }
    try {
      if (!res.writableEnded) {
        res.end()
      }
    } catch {
      // ignore
    }
  }
}

export function buildOpenRouterPayload(body) {
  return {
    ...body,
    messages: normalizeOpenRouterMessages(body?.messages),
  }
}

function normalizeOpenRouterMessages(messages) {
  if (!Array.isArray(messages)) return []

  return messages
    .map(message => normalizeOpenRouterMessage(message))
    .filter(Boolean)
}

function normalizeOpenRouterMessage(message) {
  if (!message || typeof message !== "object") return null

  const normalized = {
    ...message,
  }

  if (typeof message.content === "string") {
    normalized.content = message.content
    return normalized
  }

  if (!Array.isArray(message.content)) {
    normalized.content = typeof message.content === "string" ? message.content : ""
    return normalized
  }

  const content = []
  for (const part of message.content) {
    const normalizedPart = normalizeOpenRouterContentPart(part)
    if (normalizedPart) content.push(normalizedPart)
  }

  normalized.content = content.length > 0 ? content : ""
  return normalized
}

function normalizeOpenRouterContentPart(part) {
  if (typeof part === "string") {
    return part
      ? { type: "text", text: part }
      : null
  }

  if (!part || typeof part !== "object") return null

  if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
    const text = typeof part.text === "string" ? part.text : ""
    return text ? { type: "text", text } : null
  }

  const imagePart = normalizeOpenRouterImagePart(part)
  if (imagePart) return imagePart

  const audioPart = normalizeOpenRouterAudioPart(part)
  if (audioPart) return audioPart

  const videoPart = normalizeOpenRouterVideoPart(part)
  if (videoPart) return videoPart

  return null
}

function normalizeOpenRouterImagePart(part) {
  if (part.type === "image_url" && part.image_url) {
    const url = typeof part.image_url === "string"
      ? part.image_url
      : typeof part.image_url.url === "string"
        ? part.image_url.url
        : ""
    return url ? { type: "image_url", image_url: { url } } : null
  }

  if (part.type === "input_image") {
    const url = typeof part.image_url === "string"
      ? part.image_url
      : typeof part.url === "string"
        ? part.url
        : ""
    return url ? { type: "image_url", image_url: { url } } : null
  }

  if (part.type === "image" && part.source && typeof part.source === "object") {
    if (part.source.type === "url" && typeof part.source.url === "string" && part.source.url) {
      return {
        type: "image_url",
        image_url: { url: part.source.url },
      }
    }

    if (part.source.type === "base64" && typeof part.source.data === "string" && typeof part.source.media_type === "string") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        },
      }
    }
  }

  return null
}

function normalizeOpenRouterAudioPart(part) {
  if (part.type !== "input_audio" || !part.input_audio || typeof part.input_audio !== "object") return null
  const data = typeof part.input_audio.data === "string" ? part.input_audio.data : ""
  const format = typeof part.input_audio.format === "string" ? part.input_audio.format : ""
  if (!data || !format) return null
  return {
    type: "input_audio",
    input_audio: {
      data,
      format,
    },
  }
}

function normalizeOpenRouterVideoPart(part) {
  if (part.type !== "video_url" || !part.video_url) return null
  const url = typeof part.video_url === "string"
    ? part.video_url
    : typeof part.video_url.url === "string"
      ? part.video_url.url
      : ""
  if (!url) return null
  return {
    type: "video_url",
    video_url: { url },
  }
}

function buildOpenRouterHeaders(settings) {
  return {
    "Authorization": `Bearer ${settings.openRouterApiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  }
}
