export const MAX_REQUEST_BYTES = 8 * 1024 * 1024

export function openAIError(code, message) {
  return { error: { message, type: code } }
}

export function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

export function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function readJson(req, { maxBytes = MAX_REQUEST_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", chunk => {
      body += chunk
      if (body.length > maxBytes) {
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

export function requireShimAuth(req, res, settings) {
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

export function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase()
  return ["127.0.0.1", "localhost", "::1"].includes(normalized)
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
