import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { getPaths, ensureDir, ensureParentDir } from "./paths.js"

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 4310,
  providerId: "cmdshim",
  commandCodeBaseUrl: "https://api.commandcode.ai",
  commandCodeVersion: "0.32.2",
  compatibilityRefreshHours: 6,
  autostart: {
    enabled: false,
    provider: null,
    scope: "user",
    mode: "logon",
  },
  detectedOpenCode: {
    configFound: false,
    desktop: null,
    cli: null,
  },
}

export function readConfig() {
  const paths = getPaths()
  const fileConfig = readJsonIfExists(paths.configFile)
  const merged = mergeDeep(structuredClone(DEFAULT_CONFIG), fileConfig || {})
  merged.detectedOpenCode = {
    ...DEFAULT_CONFIG.detectedOpenCode,
    ...(merged.detectedOpenCode || {}),
  }
  merged.autostart = {
    ...DEFAULT_CONFIG.autostart,
    ...(merged.autostart || {}),
  }
  return merged
}

export function writeConfig(nextConfig) {
  const paths = getPaths()
  ensureDir(paths.dataDir)
  ensureParentDir(paths.configFile)
  writeFileSync(paths.configFile, JSON.stringify(nextConfig, null, 2), "utf8")
}

export function readSecrets() {
  const paths = getPaths()
  const secrets = readJsonIfExists(paths.secretsFile) || {}
  if (!secrets.shimAccessToken) {
    secrets.shimAccessToken = randomBytes(32).toString("hex")
    ensureDir(paths.dataDir)
    ensureParentDir(paths.secretsFile)
    writeFileSync(paths.secretsFile, JSON.stringify(secrets, null, 2), "utf8")
  }
  return secrets
}

export function writeSecrets(nextSecrets) {
  const paths = getPaths()
  ensureDir(paths.dataDir)
  ensureParentDir(paths.secretsFile)
  writeFileSync(paths.secretsFile, JSON.stringify(nextSecrets, null, 2), "utf8")
}

export function loadLegacyEnvIntoProcess() {
  const paths = getPaths()
  if (!existsSync(paths.legacyEnvFile)) return
  const raw = readFileSync(paths.legacyEnvFile, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

export function getRuntimeSettings() {
  loadLegacyEnvIntoProcess()
  const config = readConfig()
  const secrets = readSecrets()
  const apiKey =
    firstNonEmpty(
      process.env.COMMANDCODE_API_KEY,
      process.env.COMMAND_CODE_API_KEY,
      secrets.commandCodeApiKey,
    ) || ""

  return {
    host: firstNonEmpty(process.env.OCG_HOST, process.env.SHIM_HOST, process.env.CC_GO_SHIM_HOST, config.host) || DEFAULT_CONFIG.host,
    port: Number(firstNonEmpty(process.env.SHIM_PORT, process.env.CC_GO_SHIM_PORT, String(config.port || DEFAULT_CONFIG.port))),
    commandCodeApiKey: apiKey,
    shimAccessToken: firstNonEmpty(process.env.OCG_TOKEN, process.env.COMMANDCODE_SHIM_TOKEN, secrets.shimAccessToken) || "",
    commandCodeBaseUrl: String(firstNonEmpty(process.env.COMMANDCODE_BASE_URL, config.commandCodeBaseUrl) || DEFAULT_CONFIG.commandCodeBaseUrl).replace(/\/+$/, ""),
    commandCodeVersion: firstNonEmpty(process.env.COMMANDCODE_VERSION, process.env.COMMAND_CODE_CLI_VERSION, config.commandCodeVersion) || DEFAULT_CONFIG.commandCodeVersion,
    compatibilityRefreshHours: Number(config.compatibilityRefreshHours || DEFAULT_CONFIG.compatibilityRefreshHours),
    providerId: config.providerId || DEFAULT_CONFIG.providerId,
    allowRemoteHost: isEnabled(process.env.OCG_ALLOW_REMOTE) || isEnabled(process.env.COMMANDCODE_SHIM_ALLOW_REMOTE) || isEnabled(process.env.CC_GO_SHIM_ALLOW_REMOTE),
  }
}

export function readCompatibilityMatrix() {
  const paths = getPaths()
  const current = readJsonIfExists(paths.compatibilityFile)
  if (current) return current
  const legacy = readJsonIfExists(paths.legacyCompatibilityFile)
  if (legacy) return legacy
  return {
    updated_at: null,
    refresh_interval_hours: DEFAULT_CONFIG.compatibilityRefreshHours,
    models: {},
  }
}

export function writeCompatibilityMatrix(matrix) {
  const paths = getPaths()
  ensureDir(paths.dataDir)
  ensureParentDir(paths.compatibilityFile)
  writeFileSync(paths.compatibilityFile, JSON.stringify(matrix, null, 2), "utf8")
}

export function readPid() {
  const paths = getPaths()
  if (!existsSync(paths.pidFile)) return null
  const raw = readFileSync(paths.pidFile, "utf8").trim()
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function writePid(pid) {
  const paths = getPaths()
  ensureDir(paths.dataDir)
  writeFileSync(paths.pidFile, String(pid), "utf8")
}

export function clearPid() {
  const paths = getPaths()
  if (existsSync(paths.pidFile)) unlinkSync(paths.pidFile)
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function isEnabled(value) {
  const normalized = String(value || "").trim().toLowerCase()
  return ["1", "true", "yes", "y", "on"].includes(normalized)
}

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return base
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = base[key] && typeof base[key] === "object" && !Array.isArray(base[key]) ? base[key] : {}
      base[key] = mergeDeep(current, value)
      continue
    }
    base[key] = value
  }
  return base
}
