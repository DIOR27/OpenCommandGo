import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { disableAutostart, enableAutostart, getAutostartStatus } from "../autostart/index.js"
import { clearPid, clearWatchdogPid, getRuntimeSettings, readCompatibilityMatrix, readConfig, readPid, readSecrets, readWatchdogPid, writeConfig, writePid, writeSecrets, writeWatchdogPid } from "../config/store.js"
import { getPaths } from "../config/paths.js"
import { detectOpenCodeInstallations, inspectOpenCodeProvider, removeOpenCodeProvider, syncOpenCodeConfig } from "../opencode/config.js"
import { refreshModelCatalogNow, startServer } from "../runtime/server.js"
import { getLocale, t } from "../shared/i18n.js"
import { findPidByPort, gracefulKill, isProcessAlive, sleep } from "../shared/process-utils.js"

export async function runCli(args) {
  const [command = "help", ...rest] = args

  switch (command) {
    case "setup":
      await runSetup()
      return
    case "set-api-key":
      await setApiKey()
      return
    case "start":
      await startCommand(rest)
      return
    case "serve":
      await startServer()
      return
    case "status":
      await statusCommand()
      return
    case "doctor":
      await doctorCommand()
      return
    case "logs":
      await logsCommand(rest)
      return
    case "refresh-models":
      await refreshModelsCommand(rest)
      return
    case "stop":
      await stopCommand()
      return
    case "enable-autostart":
      await enableAutostartCommand()
      return
    case "disable-autostart":
      await disableAutostartCommand()
      return
    case "autostart-status":
      await autostartStatusCommand()
      return
    case "autostart":
      await autostartCommand(rest)
      return
    case "reset":
      await resetCommand()
      return
    case "uninstall":
      await uninstallCommand()
      return
    case "help":
    default:
      printHelp()
  }
}

async function runSetup() {
  const rl = createInterface({ input: stdin, output: stdout })
  const currentConfig = readConfig()
  const currentSecrets = readSecrets()
  const detected = detectOpenCodeInstallations()

  try {
    console.log(t("setup.title"))
    console.log(t("setup.opencode.config", detected.configFound ? t("status.yes") : t("status.no"), detected.configFile))
    console.log(t("setup.opencode.desktop", detected.desktop || t("misc.no")))
    console.log(t("setup.opencode.cli", detected.cli || t("misc.no")))
    console.log("")

    const apiKey = await askRequired(
      rl,
      t("setup.api_key.prompt", currentSecrets.commandCodeApiKey ? t("misc.enter_keep") : ""),
      currentSecrets.commandCodeApiKey || "",
    )

    const portInput = await rl.question(t("setup.port.prompt", currentConfig.port))
    const port = normalizePort(portInput, currentConfig.port)

    const autostartAnswer = await rl.question(t("setup.autostart.prompt"))
    const autostartEnabled = normalizeYesNo(autostartAnswer, true)

    const nextConfig = {
      ...currentConfig,
      port,
      detectedOpenCode: {
        configFound: detected.configFound,
        desktop: detected.desktop,
        cli: detected.cli,
      },
    }
    writeConfig(nextConfig)
    writeSecrets({
      ...currentSecrets,
      commandCodeApiKey: apiKey,
    })

    if (detected.configFound) {
      const target = syncOpenCodeConfig({
        providerId: nextConfig.providerId,
        host: nextConfig.host,
        port: nextConfig.port,
        compatibilityMatrix: readCompatibilityMatrix(),
        createIfMissing: false,
      })
      if (target) console.log(t("setup.synced", target))
    } else {
      console.log(t("setup.not_detected"))
    }

    if (autostartEnabled) {
      await enableAutostartCommand({ silentPrefix: true })
    } else {
      const refreshed = readConfig()
      refreshed.autostart = {
        ...(refreshed.autostart || {}),
        enabled: false,
      }
      writeConfig(refreshed)
      console.log(t("setup.autostart.disabled"))
    }

    console.log(t("setup.config_saved", getPaths().configFile))
    console.log(t("setup.secrets_saved", getPaths().secretsFile))
  } finally {
    rl.close()
  }
}

async function setApiKey() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const currentSecrets = readSecrets()
    const apiKey = await askRequired(
      rl,
      t("setapikey.prompt", currentSecrets.commandCodeApiKey ? t("misc.enter_keep") : ""),
      currentSecrets.commandCodeApiKey || "",
    )
    writeSecrets({
      ...currentSecrets,
      commandCodeApiKey: apiKey,
    })
    console.log(t("setapikey.saved", getPaths().secretsFile))
  } finally {
    rl.close()
  }
}

async function startCommand(args) {
  const background = args.includes("--background")
  const settings = getRuntimeSettings()

  // Refresh catalog before starting (catalog-only, no probes)
  console.log(t("start.refreshing"))
  try {
    await refreshModelCatalogNow({
      probeMode: "catalog",
      verifyAvailability: false,
    })
    console.log(t("start.updated"))
  } catch (error) {
    console.log(t("start.warning"))
  }

  if (!background) {
    await startServer()
    return
  }

  const pid = readPid()
  if (pid && isProcessAlive(pid)) {
    console.log(t("start.already_running", pid))
    return
  }

  const probeBeforeStart = await probeLocalShim(settings.host, settings.port, settings.shimAccessToken)
  if (probeBeforeStart.status === "healthy") {
    console.log(t("start.already_running_port", settings.host, settings.port))
    return
  }
  if (probeBeforeStart.status === "unauthorized") {
    console.log(t("start.port_conflict", settings.port))
    return
  }

  const entry = fileURLToPath(new URL("../../bin/ocg.js", import.meta.url))
  const child = spawn(process.execPath, [entry, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()

  const started = await waitForShimReady({
    pid: child.pid,
    host: settings.host,
    port: settings.port,
    token: settings.shimAccessToken,
  })

  if (!started) {
    clearPid()
    console.log(t("start.failed"))
    return
  }

  writePid(child.pid)
  console.log(t("start.launched", child.pid))

  // Launch watchdog daemon for auto-recovery
  await spawnWatchdog(entry, child.pid, settings)
  console.log(t("start.watchdog_active"))
}

async function statusCommand() {
  const settings = getRuntimeSettings()
  const config = readConfig()
  const detected = detectOpenCodeInstallations()
  const health = await readHealth(settings.host, settings.port)
  const autostart = await getAutostartStatus()
  const compatibility = readCompatibilityMatrix()
  const modelCount = Object.values(compatibility.models || {}).filter(model => model?.status !== "broken").length
  console.log(t("status.shim", health ? t("status.active") : t("status.inactive"), settings.host, settings.port))
  if (health) console.log(t("status.provider", health.provider))
  console.log(t("status.config", getPaths().configFile))
  console.log(t("status.secrets", getPaths().secretsFile))
  console.log(t("status.opencode_config", detected.configFile))
  console.log(t("status.provider_registered", inspectOpenCodeProvider(config.providerId) ? t("status.yes") : t("status.no")))
  console.log(t("status.desktop_detected", detected.desktop || t("status.no")))
  console.log(t("status.cli_detected", detected.cli || t("status.no")))
  console.log(t("status.autostart_enabled", autostart.enabled ? t("status.yes") : t("status.no")))
  console.log(t("status.autostart_provider", autostart.provider || t("status.no")))
  console.log(t("status.models_count", modelCount))
}

async function doctorCommand() {
  const settings = getRuntimeSettings()
  const config = readConfig()
  const detected = detectOpenCodeInstallations()
  const health = await readHealth(settings.host, settings.port)
  const provider = inspectOpenCodeProvider(config.providerId)
  const autostart = await getAutostartStatus()
  const compatibility = readCompatibilityMatrix()
  const modelCount = Object.values(compatibility.models || {}).filter(model => model?.status !== "broken").length

  // Local checks
  console.log(t("doctor.shim_health", health ? t("doctor.up") : t("doctor.down")))

  // Watchdog status
  const watchdogPid = readWatchdogPid()
  if (watchdogPid && isProcessAlive(watchdogPid)) {
    const paths = getPaths()
    let restarts = 0
    if (existsSync(paths.watchdogLogFile)) {
      try {
        const content = readFileSync(paths.watchdogLogFile, "utf8")
        restarts = countWatchdogRestarts(content)
      } catch { /* ignore */ }
    }
    const suffix = restarts > 0 ? t("doctor.watchdog_restarts", String(restarts)) : ""
    console.log(t("doctor.watchdog", `${t("doctor.watchdog_active")}${suffix ? " " + suffix : ""}`))
  } else {
    console.log(t("doctor.watchdog", t("doctor.watchdog_inactive")))
  }
  console.log(t("doctor.opencode_config", detected.configFound ? t("status.yes") : t("status.no")))
  console.log(t("doctor.provider", provider ? t("status.yes") : t("status.no")))
  console.log(t("doctor.desktop", detected.desktop ? t("status.yes") : t("status.no")))
  console.log(t("doctor.cli", detected.cli ? t("status.yes") : t("status.no")))
  console.log(t("doctor.compat_matrix", getPaths().compatibilityFile))
  console.log(t("doctor.catalog_age", formatCatalogAge(compatibility.updated_at)))
  console.log(t("doctor.autostart", autostart.enabled ? t("status.yes") : t("status.no")))
  console.log(t("doctor.autostart_provider", autostart.provider || t("misc.unknown")))
  console.log(t("doctor.models", modelCount))

  // Remote checks (only if API key exists)
  if (settings.commandCodeApiKey) {
    // Connectivity check
    const connectivityOk = await checkConnectivity(settings.commandCodeBaseUrl)
    console.log(t("doctor.connectivity", settings.commandCodeBaseUrl, connectivityOk ? t("doctor.connectivity_ok") : t("doctor.connectivity_fail")))

    // API key validation (replaces the static "API key: ok" check above)
    const validation = await verifyApiKey(settings.commandCodeBaseUrl, settings.commandCodeApiKey)
    if (validation.valid) {
      console.log(t("doctor.api_key_valid", t("doctor.api_key_yes")))
    } else {
      console.log(t("doctor.api_key_valid", t("doctor.api_key_no")))
      if (validation.error) {
        console.log(t("doctor.api_key_error", validation.error))
      }
    }
  } else {
    console.log(t("doctor.api_key", t("doctor.missing")))
  }
}

async function checkConnectivity(baseUrl) {
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    })
    return true
  } catch {
    return false
  }
}

async function verifyApiKey(baseUrl, apiKey) {
  try {
    const response = await fetch(`${baseUrl}/provider/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (response.ok) {
      return { valid: true }
    }
    if (response.status === 401) {
      return { valid: false, error: `${response.status} — unauthorized` }
    }
    return { valid: false, error: `${response.status} ${response.statusText}` }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function refreshModelsCommand(args = []) {
  const options = parseRefreshModelsArgs(args)
  console.log(t("refresh.start"))
  const shouldProbe = await resolveRefreshProbeConsent(options)
  const matrix = await refreshModelCatalogNow({
    probeMode: shouldProbe ? (options.full ? "full" : "fast") : "catalog",
    verifyAvailability: shouldProbe,
    concurrency: options.concurrency,
    onProgress(event) {
      if (event.type === "catalog") {
        console.log(t("refresh.catalog", event.message))
        return
      }
      if (event.type === "model-start") {
        console.log(t("refresh.model_start", event.index, event.total, event.model))
        return
      }
      if (event.type === "model-done") {
        console.log(t("refresh.model_done", event.status))
      }
    },
  })
  const useful = Object.entries(matrix.models || {})
    .filter(([, info]) => info?.status !== "broken")
    .map(([id]) => id)
  console.log(t("refresh.complete", useful.length))
}

export function parseRefreshModelsArgs(args) {
  const values = Array.isArray(args) ? args : []
  let full = false
  let concurrency = undefined
  let yes = false
  let probe = false

  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "").trim()
    if (!value) continue

    if (value === "--full") {
      full = true
      probe = true
      continue
    }

    if (value === "--yes") {
      yes = true
      continue
    }

    if (value === "--probe" || value === "--verify") {
      probe = true
      continue
    }

    if (value === "--parallel" || value === "--concurrency") {
      const raw = String(values[index + 1] || "").trim()
      const parsed = Number(raw)
      if (Number.isInteger(parsed) && parsed > 0) {
        concurrency = parsed
        index += 1
      }
      continue
    }

    const match = value.match(/^--(?:parallel|concurrency)=(\d+)$/)
    if (match) {
      const parsed = Number(match[1])
      if (Number.isInteger(parsed) && parsed > 0) {
        concurrency = parsed
      }
    }
  }

  return { full, concurrency, yes, probe }
}

async function resolveRefreshProbeConsent(options) {
  if (!options?.probe) return false
  if (options.yes) return true

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    console.log(t("refresh.probe_warning"))
    const answer = await rl.question(t("refresh.probe_confirm"))
    return normalizeYesNo(answer, false)
  } finally {
    rl.close()
  }
}

async function logsCommand(args = []) {
  const paths = getPaths()
  let watchdog = false
  let lines = 50
  let follow = false

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "").trim()
    if (!arg) continue
    if (arg === "--watchdog") {
      watchdog = true
      continue
    }
    if (arg === "-f" || arg === "--follow") {
      follow = true
      continue
    }
    if ((arg === "-n" || arg === "--lines") && i + 1 < args.length) {
      const n = Number(args[i + 1])
      if (Number.isInteger(n) && n > 0) {
        lines = n
        i++
      }
      continue
    }
    const match = arg.match(/^--lines=(\d+)$/)
    if (match) {
      const n = Number(match[1])
      if (n > 0) lines = n
      continue
    }
    const shortMatch = arg.match(/^-n(\d+)$/)
    if (shortMatch) {
      const n = Number(shortMatch[1])
      if (n > 0) lines = n
      continue
    }
  }

  const logFile = watchdog ? paths.watchdogLogFile : paths.logFile
  if (!existsSync(logFile)) {
    console.log(t("logs.no_file", logFile))
    return
  }

  console.log(t(watchdog ? "logs.watchdog_header" : "logs.header", logFile))
  console.log(t("logs.lines", lines))

  const tail = readTail(logFile, lines)
  for (const line of tail) {
    console.log(line)
  }

  if (follow) {
    await followLog(logFile, tail.length)
  }
}

export function readTail(filePath, count) {
  const content = readFileSync(filePath, "utf8")
  const allLines = content.split(/\r?\n/)
  return allLines.slice(-count)
}

async function followLog(filePath, initialLineCount) {
  console.log(t("logs.following"))

  process.on("SIGINT", () => process.exit(0))
  process.on("SIGTERM", () => process.exit(0))

  let seenLines = initialLineCount
  while (true) {
    await sleep(1000)
    try {
      const content = readFileSync(filePath, "utf8")
      const allLines = content.split(/\r?\n/)
      // Detect log rotation: if the file shrank significantly, restart
      if (allLines.length < Math.floor(seenLines * 0.5)) {
        seenLines = 0
      }
      if (allLines.length > seenLines) {
        for (let i = seenLines; i < allLines.length; i++) {
          if (allLines[i]) console.log(allLines[i])
        }
        seenLines = allLines.length
      }
    } catch {
      // File might be temporarily unavailable
    }
  }
}

async function stopCommand() {
  const settings = getRuntimeSettings()
  const savedPid = readPid()

  // Kill watchdog first (if any)
  await killWatchdog()

  // Case 1: PID saved and process alive — graceful shutdown
  if (savedPid && isProcessAlive(savedPid)) {
    console.log(t("stop.graceful", savedPid))
    const shutdownUrl = `http://${settings.host}:${settings.port}/shutdown`
    await gracefulKill(savedPid, {
      onForceTimeout: () => console.log(t("stop.graceful_timeout")),
      shutdownUrl,
      shutdownToken: settings.shimAccessToken,
    })
    clearPid()
    console.log(t("stop.stopped", savedPid))
    return
  }

  // Case 2: PID saved but process already dead — clean and fall through to port scan
  if (savedPid) {
    clearPid()
    console.log(t("stop.already_gone"))
    // Don't return — there could be a different stale process on the port
  }

  // Case 3: No PID saved — fall back to port scan
  const foundPid = findPidByPort(settings.port)
  if (!foundPid) {
    console.log(t("stop.port_not_occupied", settings.port))
    return
  }

  // Don't kill ourselves
  if (foundPid === process.pid) {
    console.log(t("stop.skipped_self", foundPid))
    clearPid()
    return
  }

  console.log(t("stop.found_by_port", foundPid, settings.port))
  const shutdownUrl = `http://${settings.host}:${settings.port}/shutdown`
  await gracefulKill(foundPid, {
    onForceTimeout: () => console.log(t("stop.graceful_timeout")),
    shutdownUrl,
    shutdownToken: settings.shimAccessToken,
  })
  clearPid()
  console.log(t("stop.killed_by_port", settings.port, foundPid))
}

async function autostartCommand(args) {
  const [subcommand = "status"] = args
  switch (subcommand) {
    case "enable":
      await enableAutostartCommand()
      return
    case "disable":
      await disableAutostartCommand()
      return
    case "status":
      await autostartStatusCommand()
      return
    default:
      console.log(t("autostart.usage"))
  }
}

async function enableAutostartCommand(options = {}) {
  const result = await enableAutostart()
  if (!options.silentPrefix) console.log(t("autostart.enabled"))
  console.log(t("autostart.provider", result.provider))
  console.log(t("autostart.command"))
}

async function disableAutostartCommand() {
  const result = await disableAutostart()
  console.log(t("autostart.disabled"))
  console.log(t("autostart.provider", result.provider))
}

async function autostartStatusCommand() {
  const status = await getAutostartStatus()
  console.log(t("autostart.status", status.enabled ? t("autostart.enabled_label") : t("autostart.disabled_label")))
  console.log(t("autostart.status_provider", status.provider || t("misc.unknown")))
  console.log(t("autostart.mode", status.mode))
  console.log(t("autostart.command_line", status.command))
  console.log(t(status.matchesConfig ? "autostart.sync_yes" : "autostart.sync_no", status.matchesConfig ? t("status.yes") : t("status.no")))
}

async function resetCommand() {
  await stopCommand()
  const paths = getPaths()

  // Delete config and secrets (keep everything else: compat matrix, logs, PID, watchdogs)
  let deleted = []
  if (existsSync(paths.configFile)) {
    rmSync(paths.configFile)
    deleted.push(paths.configFile)
  }
  if (existsSync(paths.secretsFile)) {
    rmSync(paths.secretsFile)
    deleted.push(paths.secretsFile)
  }

  if (deleted.length === 0) {
    console.log(t("reset.nothing"))
    return
  }

  console.log(t("reset.done"))
  for (const file of deleted) {
    console.log(`  ${t("reset.deleted", file)}`)
  }
  console.log(t("reset.regenerate"))
}

async function uninstallCommand() {
  await stopCommand()
  await disableAutostart()
  const config = readConfig()
  const removedProvider = removeOpenCodeProvider(config.providerId)
  const dataDir = getPaths().dataDir
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
  clearPid()
  console.log(t(removedProvider ? "uninstall.provider_removed" : "uninstall.provider_not_found"))
  console.log(t("uninstall.data_deleted", dataDir))
  console.log(t("uninstall.done"))
}

function printHelp() {
  console.log(t("help.text"))
}

async function askRequired(rl, label, fallback = "") {
  while (true) {
    const value = (await rl.question(label)).trim()
    if (value) return value
    if (fallback) return fallback
    console.log(t("error.required"))
  }
}

function normalizeYesNo(value, defaultValue) {
  const normalized = String(value || "").trim().toLowerCase()
  if (!normalized) return defaultValue
  return !["n", "no"].includes(normalized)
}

function normalizePort(value, fallback) {
  const next = Number(String(value || "").trim())
  if (Number.isInteger(next) && next > 0 && next <= 65535) return next
  return fallback
}

async function readHealth(host, port) {
  const settings = getRuntimeSettings()
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      headers: getShimHeaders(settings.shimAccessToken),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function probeLocalShim(host, port, token) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      headers: getShimHeaders(token),
    })
    if (response.ok) {
      return {
        status: "healthy",
        body: await response.json(),
      }
    }
    if (response.status === 401) {
      return { status: "unauthorized" }
    }
    return { status: "other_http", code: response.status }
  } catch {
    return { status: "offline" }
  }
}

async function waitForShimReady({ pid, host, port, token }) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const probe = await probeLocalShim(host, port, token)
    if (probe.status === "healthy") return true
    if (probe.status === "unauthorized") return false
    if (!isProcessAlive(pid)) return false
    await sleep(200)
  }
  return false
}

async function spawnWatchdog(entry, shimPid, settings) {
  const watchdogEntry = fileURLToPath(new URL("../watchdog/index.js", import.meta.url))
  const config = JSON.stringify({
    shimPid,
    host: settings.host,
    port: settings.port,
    token: settings.shimAccessToken,
    executablePath: process.execPath,
    entryPath: entry,
  })
  const child = spawn(process.execPath, [watchdogEntry, config], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  writeWatchdogPid(child.pid)
}

async function killWatchdog() {
  const watchdogPid = readWatchdogPid()
  if (watchdogPid && isProcessAlive(watchdogPid)) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/PID", String(watchdogPid)], {
          stdio: "ignore",
        })
      } else {
        process.kill(watchdogPid, "SIGKILL")
      }
    } catch {
      // Already gone
    }
  }
  clearWatchdogPid()
}

export function formatCatalogAge(updatedAt) {
  if (!updatedAt) return t("misc.unknown")
  const ageMs = Date.now() - new Date(updatedAt).getTime()
  if (ageMs < 0) return t("misc.unknown")

  const es = getLocale() === "es"
  const hours = Math.floor(ageMs / 3600000)
  const minutes = Math.floor((ageMs % 3600000) / 60000)

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return es ? `hace ${days}d` : `${days}d ago`
  }
  if (hours >= 1) return es ? `hace ${hours}h ${minutes}m` : `${hours}h ${minutes}m ago`
  if (minutes >= 1) return es ? `hace ${minutes}m` : `${minutes}m ago`
  return es ? "<1m" : "<1m ago"
}

function getShimHeaders(token) {
  return {
    "x-ocg-token": token,
  }
}

export function countWatchdogRestarts(content) {
  return (String(content || "").match(/restart OK/g) || []).length
}
