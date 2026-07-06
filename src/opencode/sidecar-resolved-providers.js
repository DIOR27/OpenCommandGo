import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_DESKTOP_ROOT = join(homedir(), ".config", "ai.opencode.desktop")
const DEFAULT_LOGS_DIR = join(DEFAULT_DESKTOP_ROOT, "logs")
const SIDECAR_URL_PATTERN = /server ready \{ url: '([^']+)' \}/g
const PROVIDER_ENDPOINTS = ["/provider", "/config/providers"]

export async function readResolvedProvidersFromSidecar(options = {}) {
  const discovery = discoverOpenCodeSidecar(options)
  if (!discovery.ok) {
    return { ok: false, code: discovery.code, providers: {}, source: null }
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") {
    return { ok: false, code: "fetch-unavailable", providers: {}, source: null }
  }

  const authCandidates = resolveSidecarAuthCandidates(options)
  let unauthorized = false
  let lastErrorCode = "sidecar-fetch-failed"

  for (const endpoint of PROVIDER_ENDPOINTS) {
    for (const candidate of authCandidates) {
      try {
        const response = await fetchImpl(`${discovery.baseUrl}${endpoint}`, {
          headers: buildRequestHeaders(candidate),
          signal: AbortSignal.timeout(options.timeoutMs || 2000),
        })

        if (response.status === 401 || response.status === 403) {
          unauthorized = true
          lastErrorCode = "unauthorized"
          continue
        }

        if (!response.ok) {
          lastErrorCode = `http-${response.status}`
          continue
        }

        const payload = await response.json()
        const providers = normalizeResolvedProviders(payload)
        if (Object.keys(providers).length === 0) {
          lastErrorCode = "empty-payload"
          continue
        }

        return {
          ok: true,
          code: "ok",
          providers,
          source: {
            kind: "sidecar",
            baseUrl: discovery.baseUrl,
            endpoint,
            auth: candidate?.kind || "none",
          },
        }
      } catch (error) {
        lastErrorCode = classifyFetchError(error)
      }
    }
  }

  return {
    ok: false,
    code: unauthorized ? "unauthorized" : lastErrorCode,
    providers: {},
    source: discovery.baseUrl ? { kind: "sidecar", baseUrl: discovery.baseUrl } : null,
  }
}

export function discoverOpenCodeSidecar(options = {}) {
  const logFiles = Array.isArray(options.logFiles) && options.logFiles.length > 0
    ? options.logFiles
    : listDesktopMainLogs(options.desktopLogsDir || DEFAULT_LOGS_DIR)
  for (const file of logFiles) {
    const url = extractLatestSidecarUrl(readTextFile(file))
    if (url) {
      return { ok: true, code: "ok", baseUrl: url, logFile: file }
    }
  }
  return { ok: false, code: logFiles.length > 0 ? "sidecar-url-missing" : "desktop-logs-missing", baseUrl: null, logFile: null }
}

export function extractLatestSidecarUrl(content) {
  const text = String(content || "")
  let match = null
  let lastUrl = null
  while ((match = SIDECAR_URL_PATTERN.exec(text))) {
    lastUrl = match[1]
  }
  return lastUrl
}

export function normalizeResolvedProviders(payload) {
  const providers = {}
  for (const provider of normalizeProviderList(payload)) {
    const providerId = normalizeProviderId(provider)
    if (!providerId) continue
    const models = normalizeProviderModels(provider)
    if (Object.keys(models).length === 0) continue
    providers[providerId] = { models }
  }
  return providers
}

export function resolveSidecarAuthCandidates(options = {}) {
  const normalized = []
  const seen = new Set()
  const candidates = [
    ...(Array.isArray(options.authCandidates) ? options.authCandidates : []),
    readAuthCandidateFromEnv(),
    { kind: "none" },
  ].filter(Boolean)

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeAuthCandidate(candidate)
    if (!normalizedCandidate) continue
    const key = JSON.stringify(normalizedCandidate)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(normalizedCandidate)
  }

  return normalized
}

function listDesktopMainLogs(logsDir) {
  if (!logsDir || !existsSync(logsDir)) return []
  return readdirSync(logsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(logsDir, entry.name, "main.log"))
    .filter(file => existsSync(file))
    .sort((left, right) => right.localeCompare(left))
}

function readTextFile(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

function normalizeProviderList(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== "object") return []
  for (const key of ["providers", "data", "items"]) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  if (payload.providers && typeof payload.providers === "object") {
    return Object.entries(payload.providers).map(([id, value]) => ({ id, ...(value && typeof value === "object" ? value : {}) }))
  }
  return []
}

function normalizeProviderId(provider) {
  const value = provider?.id || provider?.providerID || provider?.providerId || provider?.slug || provider?.key || provider?.name
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalizeProviderModels(provider) {
  const models = provider?.models || provider?.modelMap || provider?.catalog || provider?.data
  if (Array.isArray(models)) {
    return Object.fromEntries(
      models
        .map(model => {
          const modelId = normalizeModelId(model)
          if (!modelId) return null
          return [modelId, normalizeModelEntry(model)]
        })
        .filter(Boolean),
    )
  }
  if (models && typeof models === "object") {
    return Object.fromEntries(
      Object.entries(models)
        .map(([modelId, value]) => [modelId, normalizeModelEntry(value)])
        .filter(([modelId]) => typeof modelId === "string" && modelId.trim()),
    )
  }
  return {}
}

function normalizeModelId(model) {
  const value = model?.id || model?.modelID || model?.modelId || model?.name
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalizeModelEntry(model) {
  if (!model || typeof model !== "object") return {}
  return {
    ...model,
    limit: normalizeLimit(model.limit, model.contextWindow, model.context_length),
    modalities: normalizeModalities(model.modalities),
    capabilities: normalizeCapabilities(model.capabilities),
    reasoning: normalizeReasoning(model.reasoning),
  }
}

function normalizeLimit(limit, contextWindow, legacyContextWindow) {
  const context = limit?.context ?? contextWindow ?? legacyContextWindow ?? null
  if (context === null || context === undefined) return limit && typeof limit === "object" ? { ...limit } : {}
  return { ...(limit && typeof limit === "object" ? limit : {}), context }
}

function normalizeModalities(modalities) {
  if (!modalities || typeof modalities !== "object") return {}
  return {
    ...modalities,
    input: Array.isArray(modalities.input) ? modalities.input : [],
    output: Array.isArray(modalities.output) ? modalities.output : [],
  }
}

function normalizeCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return {}
  return capabilities
}

function normalizeReasoning(reasoning) {
  return typeof reasoning === "boolean" ? reasoning : reasoning
}

function readAuthCandidateFromEnv() {
  if (process.env.OPENCODE_SERVER_AUTHORIZATION || process.env.OPENCODE_SIDECAR_AUTHORIZATION) {
    return { kind: "authorization", authorization: process.env.OPENCODE_SERVER_AUTHORIZATION || process.env.OPENCODE_SIDECAR_AUTHORIZATION }
  }
  if (process.env.OPENCODE_SIDECAR_BASIC_TOKEN) {
    return { kind: "token", token: process.env.OPENCODE_SIDECAR_BASIC_TOKEN }
  }
  const serverUser = process.env.OPENCODE_SERVER_USERNAME
  const serverPass = process.env.OPENCODE_SERVER_PASSWORD
  if (serverUser && serverPass) {
    return { kind: "credentials", username: serverUser, password: serverPass }
  }
  const sidecarUser = process.env.OPENCODE_SIDECAR_USERNAME
  const sidecarPass = process.env.OPENCODE_SIDECAR_PASSWORD
  if (sidecarUser && sidecarPass) {
    return { kind: "credentials", username: sidecarUser, password: sidecarPass }
  }
  return null
}

function normalizeAuthCandidate(candidate) {
  if (!candidate || candidate.kind === "none") return { kind: "none" }
  if (typeof candidate.authorization === "string" && candidate.authorization.trim()) {
    return { kind: "authorization", authorization: candidate.authorization.trim() }
  }
  if (typeof candidate.token === "string" && candidate.token.trim()) {
    return { kind: "token", token: candidate.token.trim() }
  }
  if (typeof candidate.username === "string" && typeof candidate.password === "string") {
    return {
      kind: "credentials",
      username: candidate.username,
      password: candidate.password,
    }
  }
  return null
}

function buildRequestHeaders(candidate) {
  const headers = { Accept: "application/json" }
  if (!candidate || candidate.kind === "none") return headers
  if (candidate.kind === "authorization") {
    headers.Authorization = candidate.authorization
    return headers
  }
  if (candidate.kind === "token") {
    headers.Authorization = `Basic ${Buffer.from(candidate.token).toString("base64")}`
    return headers
  }
  headers.Authorization = `Basic ${Buffer.from(`${candidate.username}:${candidate.password}`).toString("base64")}`
  return headers
}

function classifyFetchError(error) {
  if (error?.name === "TimeoutError") return "timeout"
  if (error?.name === "AbortError") return "timeout"
  return "sidecar-fetch-failed"
}
