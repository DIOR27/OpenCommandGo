import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { readConfig, writeConfig } from "../config/store.js"
import { detectOpenCodeInstallations } from "../opencode/config.js"

const ROOT_VERB = "CommandCodeShimOpenCode"
const SHELL_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${ROOT_VERB}`
const SHELL_BG_KEY = `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${ROOT_VERB}`
const COMMAND_STORE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CommandStore\\shell"
const MENU_LABEL = "Abrir con OpenCode"
const ICON_FALLBACK = join(process.env.LOCALAPPDATA || "", "Programs", "OpenCode", "OpenCode.exe")

export function canManageWindowsShell() {
  return process.platform === "win32"
}

export function installWindowsShellIntegration() {
  if (!canManageWindowsShell()) return { installed: false, reason: "not_windows" }
  const command = resolveShellCommand()
  if (!command) return { installed: false, reason: "missing_command" }

  const detected = detectOpenCodeInstallations()
  const icon = detected.desktop && existsSync(detected.desktop) ? detected.desktop : ICON_FALLBACK

  removeWindowsShellIntegration()

  const directoryDesktopVerb = `${ROOT_VERB}.directory.desktop`
  const directoryCliVerb = `${ROOT_VERB}.directory.cli`
  const backgroundDesktopVerb = `${ROOT_VERB}.background.desktop`
  const backgroundCliVerb = `${ROOT_VERB}.background.cli`

  ensureMenuRoot(SHELL_KEY, icon, [directoryDesktopVerb, directoryCliVerb])
  ensureMenuRoot(SHELL_BG_KEY, icon, [backgroundDesktopVerb, backgroundCliVerb])

  writeCommandStoreVerb(directoryDesktopVerb, "OpenCode Desktop", command, "desktop", "%1", icon)
  writeCommandStoreVerb(directoryCliVerb, "OpenCode CLI", command, "cli", "%1", icon)
  writeCommandStoreVerb(backgroundDesktopVerb, "OpenCode Desktop", command, "desktop", "%V", icon)
  writeCommandStoreVerb(backgroundCliVerb, "OpenCode CLI", command, "cli", "%V", icon)

  const config = readConfig()
  config.shell = {
    ...(config.shell || {}),
    installed: true,
  }
  writeConfig(config)
  return { installed: true }
}

export function removeWindowsShellIntegration() {
  if (!canManageWindowsShell()) return { removed: false, reason: "not_windows" }
  execRegDelete(SHELL_KEY)
  execRegDelete(SHELL_BG_KEY)
  execRegDelete(`${COMMAND_STORE_KEY}\\${ROOT_VERB}.directory.desktop`)
  execRegDelete(`${COMMAND_STORE_KEY}\\${ROOT_VERB}.directory.cli`)
  execRegDelete(`${COMMAND_STORE_KEY}\\${ROOT_VERB}.background.desktop`)
  execRegDelete(`${COMMAND_STORE_KEY}\\${ROOT_VERB}.background.cli`)
  const config = readConfig()
  config.shell = {
    ...(config.shell || {}),
    installed: false,
  }
  writeConfig(config)
  return { removed: true }
}

export async function chooseAndLaunchOpenCode(targetPath, ensureShimRunning) {
  const detected = detectOpenCodeInstallations()
  const availableTargets = {
    desktop: detected.desktop && existsSync(detected.desktop) ? detected.desktop : null,
    cli: detected.cli && existsSync(detected.cli) ? detected.cli : null,
  }

  if (!availableTargets.desktop && !availableTargets.cli) {
    throw new Error("No detecté OpenCode Desktop ni OpenCode CLI instalados.")
  }

  await ensureShimRunning()

  const selected =
    availableTargets.desktop && !availableTargets.cli ? "desktop"
      : !availableTargets.desktop && availableTargets.cli ? "cli"
        : null

  if (!selected) {
    throw new Error("Hay múltiples destinos disponibles. Usá el submenú Desktop/CLI del Explorador.")
  }

  launchTarget(selected, availableTargets[selected], targetPath)
}

export async function launchSpecificOpenCodeTarget(target, targetPath, ensureShimRunning) {
  const detected = detectOpenCodeInstallations()
  const availableTargets = {
    desktop: detected.desktop && existsSync(detected.desktop) ? detected.desktop : null,
    cli: detected.cli && existsSync(detected.cli) ? detected.cli : null,
  }
  if (target !== "desktop" && target !== "cli") {
    throw new Error(`Target no soportado: ${target}`)
  }
  if (!availableTargets[target]) {
    throw new Error(`No encontré OpenCode ${target === "desktop" ? "Desktop" : "CLI"} instalado.`)
  }
  await ensureShimRunning()
  launchTarget(target, availableTargets[target], targetPath)
}

function launchTarget(target, executable, targetPath) {
  if (!executable) throw new Error(`No encontré el ejecutable para ${target}.`)
  const isCmdShim = /\.(cmd|bat)$/i.test(executable)
  const child = isCmdShim
    ? spawn(process.env.ComSpec || "cmd.exe", ["/c", executable, targetPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      })
    : spawn(executable, [targetPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      })
  child.unref()
}

function resolveShellCommand() {
  try {
    const output = execFileSync("where", ["commandcode-shim"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const match = output.find(line => line.toLowerCase().endsWith(".cmd")) || output[0]
    if (!match) return null
    if (/\.cmd$/i.test(match) || /\.bat$/i.test(match)) {
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
      return `"${comspec}" /d /s /c ""${match}" open-with`
    }
    return `"${match}" open-with`
  } catch {
    return null
  }
}

function ensureMenuRoot(key, icon, subcommands) {
  execFileSync("reg", ["add", key, "/ve", "/f"], { stdio: "ignore" })
  execFileSync("reg", ["add", key, "/v", "MUIVerb", "/d", MENU_LABEL, "/f"], { stdio: "ignore" })
  execFileSync("reg", ["add", key, "/v", "SubCommands", "/d", subcommands.join(";"), "/f"], { stdio: "ignore" })
  if (icon) {
    execFileSync("reg", ["add", key, "/v", "Icon", "/d", icon, "/f"], { stdio: "ignore" })
  }
}

function writeCommandStoreVerb(verb, label, commandBase, target, argToken, icon) {
  const verbKey = `${COMMAND_STORE_KEY}\\${verb}`
  execFileSync("reg", ["add", verbKey, "/ve", "/f"], { stdio: "ignore" })
  execFileSync("reg", ["add", verbKey, "/v", "MUIVerb", "/d", label, "/f"], { stdio: "ignore" })
  if (icon) {
    execFileSync("reg", ["add", verbKey, "/v", "Icon", "/d", icon, "/f"], { stdio: "ignore" })
  }
  const commandValue = commandBase.includes('cmd.exe') || commandBase.includes('cmd" /d /s /c')
    ? `${commandBase} ${target} \"${argToken}\"\"`
    : `${commandBase} ${target} \"${argToken}\"`
  execFileSync("reg", ["add", `${verbKey}\\command`, "/ve", "/d", commandValue, "/f"], { stdio: "ignore" })
}

function execRegDelete(key) {
  try {
    execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" })
  } catch {}
}
