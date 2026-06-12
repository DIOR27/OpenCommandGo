import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
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
      await refreshModelsCommand()
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
  if (!background) {
    await startServer()
    return
  }

  const pid = readPid()
  if (pid && isProcessAlive(pid)) {
    console.log(`Shim ya está corriendo con PID ${pid}.`)
    return
  }

  const entry = fileURLToPath(new URL("../../bin/commandcode-shim.js", import.meta.url))
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
  console.log(`Modelos útiles en catálogo: ${modelCount}`)
}

async function doctorCommand() {
  const settings = getRuntimeSettings()
  const config = readConfig()
  const detected = detectOpenCodeInstallations()
  const health = await readHealth(settings.host, settings.port)
  const provider = inspectOpenCodeProvider(config.providerId)
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
  console.log(`Modelos útiles en catálogo: ${modelCount}`)
}

async function refreshModelsCommand() {
  console.log("Refrescando catálogo y compatibilidad de modelos...")
  const matrix = await refreshModelCatalogNow()
  const useful = Object.entries(matrix.models || {})
    .filter(([, info]) => info?.status !== "broken")
    .map(([id]) => id)
  console.log(`Refresh completo. Modelos útiles: ${useful.length}`)
  const hasNemotron = useful.some(id => id.toLowerCase().includes("nemotron"))
  console.log(`Nemotron visible: ${hasNemotron ? "sí" : "no"}`)
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
    console.log("Uso: ccga open-with <desktop|cli> <ruta>")
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
  console.log(`ccga

Comandos:
  setup
  start [--background]
  serve
  stop
  open-path <ruta>
  open-with <desktop|cli> <ruta>
  install-shell
  uninstall-shell
  status
  doctor
  refresh-models
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
    "X-CommandCode-Shim-Token": token,
  }
}
