import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { disableAutostart, enableAutostart, getAutostartStatus } from "../autostart/index.js"
import { clearPid, getRuntimeSettings, readCompatibilityMatrix, readConfig, readPid, readSecrets, writeConfig, writePid, writeSecrets } from "../config/store.js"
import { getPaths } from "../config/paths.js"
import { detectOpenCodeInstallations, inspectOpenCodeProvider, removeOpenCodeProvider, syncOpenCodeConfig } from "../opencode/config.js"
import { refreshModelCatalogNow, startServer } from "../runtime/server.js"
import { t } from "../shared/i18n.js"
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

  console.log(t("doctor.api_key", settings.commandCodeApiKey ? t("doctor.ok") : t("doctor.missing")))
  console.log(t("doctor.shim_health", health ? t("doctor.up") : t("doctor.down")))
  console.log(t("doctor.opencode_config", detected.configFound ? t("status.yes") : t("status.no")))
  console.log(t("doctor.provider", provider ? t("status.yes") : t("status.no")))
  console.log(t("doctor.desktop", detected.desktop ? t("status.yes") : t("status.no")))
  console.log(t("doctor.cli", detected.cli ? t("status.yes") : t("status.no")))
  console.log(t("doctor.compat_matrix", getPaths().compatibilityFile))
  console.log(t("doctor.autostart", autostart.enabled ? t("status.yes") : t("status.no")))
  console.log(t("doctor.autostart_provider", autostart.provider || t("misc.unknown")))
  console.log(t("doctor.models", modelCount))
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

function parseRefreshModelsArgs(args) {
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

async function stopCommand() {
  const settings = getRuntimeSettings()
  const savedPid = readPid()

  // Case 1: PID saved and process alive — graceful shutdown
  if (savedPid && isProcessAlive(savedPid)) {
    console.log(t("stop.graceful", savedPid))
    await gracefulKill(savedPid, { onForceTimeout: () => console.log(t("stop.graceful_timeout")) })
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
  await gracefulKill(foundPid, { onForceTimeout: () => console.log(t("stop.graceful_timeout")) })
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
  console.log(t(status.matchesConfig ? "autostart.sync_yes" : "autostart.sync_no"))
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

function getShimHeaders(token) {
  return {
    "x-ocg-token": token,
  }
}
