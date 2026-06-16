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
import { canManageWindowsShell, chooseAndLaunchOpenCode, installWindowsShellIntegration, launchSpecificOpenCodeTarget, removeWindowsShellIntegration } from "../windows/shell.js"

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
    case "open-path":
      await openPathCommand(rest)
      return
    case "open-with":
      await openWithCommand(rest)
      return
    case "install-shell":
      await installShellCommand()
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
    case "uninstall-shell":
      await uninstallShellCommand()
      return
    case "reset-shell-choice":
      await resetShellChoice()
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
    console.log("Configurando Command Code Shim.\n")
    console.log(`OpenCode config: ${detected.configFound ? "detectada" : "no detectada"} -> ${detected.configFile}`)
    console.log(`OpenCode Desktop: ${detected.desktop || "no detectado"}`)
    console.log(`OpenCode CLI: ${detected.cli || "no detectado"}`)
    console.log("")

    const apiKey = await askRequired(
      rl,
      `API key de Command Code${currentSecrets.commandCodeApiKey ? " (Enter para conservar la actual)" : ""}: `,
      currentSecrets.commandCodeApiKey || "",
    )

    const portInput = await rl.question(`Puerto del shim [${currentConfig.port}]: `)
    const port = normalizePort(portInput, currentConfig.port)

    const shellAnswer = await rl.question("¿Querés instalar la integración de shell de Windows ahora? [Y/n]: ")
    const shellEnabled = normalizeYesNo(shellAnswer, true)
    const autostartAnswer = await rl.question("¿Querés habilitar inicio automático del shim al iniciar sesión? [Y/n]: ")
    const autostartEnabled = normalizeYesNo(autostartAnswer, true)

    const nextConfig = {
      ...currentConfig,
      port,
      shell: {
        ...(currentConfig.shell || {}),
        enabled: shellEnabled,
      },
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
      if (target) console.log(`OpenCode quedó configurado en: ${target}`)
    } else {
      console.log("OpenCode no está detectado todavía. Guardé la config del shim igual.")
    }

    if (shellEnabled && canManageWindowsShell() && (detected.desktop || detected.cli)) {
      const result = installWindowsShellIntegration()
      console.log(result.installed
        ? "Integración de shell de Windows instalada."
        : "No pude instalar la integración de shell de Windows.")
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
      console.log("Inicio automático deshabilitado.")
    }

    console.log(`Config guardada en: ${getPaths().configFile}`)
    console.log(`Secretos guardados en: ${getPaths().secretsFile}`)
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
      `Nueva API key de Command Code${currentSecrets.commandCodeApiKey ? " (Enter para conservar la actual)" : ""}: `,
      currentSecrets.commandCodeApiKey || "",
    )
    writeSecrets({
      ...currentSecrets,
      commandCodeApiKey: apiKey,
    })
    console.log(`API key actualizada en: ${getPaths().secretsFile}`)
  } finally {
    rl.close()
  }
}

async function startCommand(args) {
  const background = args.includes("--background")

  // Refresh catalog before starting (catalog-only, no probes)
  console.log("Refrescando catálogo de modelos...")
  try {
    await refreshModelCatalogNow({
      probeMode: "catalog",
      verifyAvailability: false,
    })
    console.log("Catálogo actualizado.")
  } catch (error) {
    console.log("Advertencia: no se pudo actualizar el catálogo, iniciando de todos modos.")
  }

  if (!background) {
    await startServer()
    return
  }

  const pid = readPid()
  if (pid && isProcessAlive(pid)) {
    console.log(`Shim ya está corriendo con PID ${pid}.`)
    return
  }

  const entry = fileURLToPath(new URL("../../bin/ocg.js", import.meta.url))
  const child = spawn(process.execPath, [entry, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  writePid(child.pid)
  console.log(`Shim lanzado en background con PID ${child.pid}.`)
}

async function statusCommand() {
  const settings = getRuntimeSettings()
  const config = readConfig()
  const detected = detectOpenCodeInstallations()
  const health = await readHealth(settings.host, settings.port)
  const autostart = await getAutostartStatus()
  const compatibility = readCompatibilityMatrix()
  const modelCount = Object.values(compatibility.models || {}).filter(model => model?.status !== "broken").length
  console.log(`Shim: ${health ? "activo" : "inactivo"} (${settings.host}:${settings.port})`)
  if (health) console.log(`Provider: ${health.provider}`)
  console.log(`Config: ${getPaths().configFile}`)
  console.log(`Secretos: ${getPaths().secretsFile}`)
  console.log(`OpenCode config: ${detected.configFile}`)
  console.log(`Provider registrado: ${inspectOpenCodeProvider(config.providerId) ? "sí" : "no"}`)
  console.log(`Desktop detectado: ${detected.desktop || "no"}`)
  console.log(`CLI detectado: ${detected.cli || "no"}`)
  console.log(`Shell Windows instalada: ${config.shell?.installed ? "sí" : "no"}`)
  console.log(`Autostart habilitado: ${autostart.enabled ? "sí" : "no"}`)
  console.log(`Autostart proveedor: ${autostart.provider || "no"}`)
  console.log(`Modelos útiles en catálogo: ${modelCount}`)
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

  console.log(`API key: ${settings.commandCodeApiKey ? "ok" : "faltante"}`)
  console.log(`Shim health: ${health ? "ok" : "caído"}`)
  console.log(`OpenCode config detectada: ${detected.configFound ? "sí" : "no"}`)
  console.log(`Provider cmdshim configurado: ${provider ? "sí" : "no"}`)
  console.log(`Desktop detectado: ${detected.desktop ? "sí" : "no"}`)
  console.log(`CLI detectado: ${detected.cli ? "sí" : "no"}`)
  console.log(`Compat matrix: ${getPaths().compatibilityFile}`)
  console.log(`Shell Windows instalada: ${config.shell?.installed ? "sí" : "no"}`)
  console.log(`Autostart configurado: ${autostart.enabled ? "sí" : "no"}`)
  console.log(`Autostart proveedor: ${autostart.provider || "no"}`)
  console.log(`Modelos útiles en catálogo: ${modelCount}`)
}

async function refreshModelsCommand(args = []) {
  const options = parseRefreshModelsArgs(args)
  console.log("Refrescando catálogo y compatibilidad de modelos...")
  const shouldProbe = await resolveRefreshProbeConsent(options)
  const matrix = await refreshModelCatalogNow({
    probeMode: shouldProbe ? (options.full ? "full" : "fast") : "catalog",
    verifyAvailability: shouldProbe,
    concurrency: options.concurrency,
    onProgress(event) {
      if (event.type === "catalog") {
        console.log(`Catálogo: ${event.message}`)
        return
      }
      if (event.type === "model-start") {
        console.log(`[${event.index}/${event.total}] ${event.model}...`)
        return
      }
      if (event.type === "model-done") {
        console.log(`  -> ${event.status}`)
      }
    },
  })
  const useful = Object.entries(matrix.models || {})
    .filter(([, info]) => info?.status !== "broken")
    .map(([id]) => id)
  console.log(`Refresh completo. Modelos útiles: ${useful.length}`)
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
    console.log("Advertencia: verificar disponibilidad real consumirá tokens/créditos en Command Code.")
    const answer = await rl.question("¿Querés continuar con los probes? [y/N]: ")
    return normalizeYesNo(answer, false)
  } finally {
    rl.close()
  }
}

async function stopCommand() {
  const pid = readPid()
  if (!pid) {
    console.log("No hay PID guardado.")
    return
  }
  if (!isProcessAlive(pid)) {
    clearPid()
    console.log("El proceso ya no existía; limpié el PID.")
    return
  }
  process.kill(pid)
  clearPid()
  console.log(`Shim detenido (PID ${pid}).`)
}

async function resetShellChoice() {
  console.log("Ya no hay elección recordada. Ahora se usa submenú contextual Desktop/CLI.")
}

async function openPathCommand(args) {
  const targetPath = args.join(" ").trim()
  if (!targetPath) {
    console.log("Falta la ruta a abrir.")
    return
  }
  await chooseAndLaunchOpenCode(targetPath, ensureShimRunning)
}

async function openWithCommand(args) {
  const [target, ...pathParts] = args
  const targetPath = pathParts.join(" ").trim()
  if (!target || !targetPath) {
    console.log("Uso: ocg open-with <desktop|cli> <ruta>")
    return
  }
  await launchSpecificOpenCodeTarget(target, targetPath, ensureShimRunning)
}

async function installShellCommand() {
  const result = installWindowsShellIntegration()
  if (result.installed) {
    console.log("Integración de shell instalada.")
    return
  }
  console.log(`No pude instalar la integración de shell (${result.reason}).`)
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
      console.log("Uso: ocg autostart <enable|disable|status>")
  }
}

async function enableAutostartCommand(options = {}) {
  const result = await enableAutostart()
  if (!options.silentPrefix) console.log("Inicio automático habilitado.")
  console.log(`Proveedor: ${result.provider}`)
  console.log("Comando: ocg start --background")
}

async function disableAutostartCommand() {
  const result = await disableAutostart()
  console.log("Inicio automático deshabilitado.")
  console.log(`Proveedor: ${result.provider}`)
}

async function autostartStatusCommand() {
  const status = await getAutostartStatus()
  console.log(`Autostart: ${status.enabled ? "habilitado" : "deshabilitado"}`)
  console.log(`Proveedor: ${status.provider || "desconocido"}`)
  console.log(`Modo: ${status.mode}`)
  console.log(`Comando: ${status.command}`)
  console.log(`Config sincronizada: ${status.matchesConfig ? "sí" : "no"}`)
}

async function uninstallShellCommand() {
  const result = removeWindowsShellIntegration()
  if (result.removed) {
    console.log("Integración de shell removida.")
    return
  }
  console.log(`No pude remover la integración de shell (${result.reason}).`)
}

async function uninstallCommand() {
  await stopCommand()
  await disableAutostart()
  if (canManageWindowsShell()) removeWindowsShellIntegration()
  const config = readConfig()
  const removedProvider = removeOpenCodeProvider(config.providerId)
  const dataDir = getPaths().dataDir
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
  clearPid()
  console.log(`Provider en OpenCode: ${removedProvider ? "removido" : "no estaba configurado"}`)
  console.log(`Datos locales borrados: ${dataDir}`)
  console.log("Desinstalación completa del shim terminada.")
}

function printHelp() {
  console.log(`ocg

Comandos:
  setup
  start [--background]
  serve
  stop
  open-path <ruta>
  open-with <desktop|cli> <ruta>
  install-shell
  enable-autostart
  disable-autostart
  autostart-status
  autostart <enable|disable|status>
  uninstall-shell
  status
  doctor
  refresh-models [--probe|--full] [--parallel N] [--yes]
  set-api-key
  reset-shell-choice
  uninstall`)
}

async function askRequired(rl, label, fallback = "") {
  while (true) {
    const value = (await rl.question(label)).trim()
    if (value) return value
    if (fallback) return fallback
    console.log("Ese valor es obligatorio.")
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

async function ensureShimRunning() {
  const settings = getRuntimeSettings()
  const alive = await readHealth(settings.host, settings.port)
  if (alive) return

  await startCommand(["--background"])
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const health = await readHealth(settings.host, settings.port)
    if (health) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("No pude arrancar el shim a tiempo.")
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getShimHeaders(token) {
  return {
    "x-ocg-token": token,
  }
}
