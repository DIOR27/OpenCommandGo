import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { readConfig, writeConfig } from "../config/store.js"
import { detectOpenCodeInstallations } from "../opencode/config.js"

const ROOT_VERB = "OpenCGCLI"
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

function resolveShellCommand() {
  const detected = detectOpenCodeInstallations()
  const desktop = detected.desktop
  if (!desktop || !existsSync(desktop)) return null
  return `"${desktop}"`

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
  // Direct executable path (quoted) — no target prefix needed
  const commandValue = `${commandBase} \"${argToken}\"`
  execFileSync("reg", ["add", `${verbKey}\\command`, "/ve", "/d", commandValue, "/f"], { stdio: "ignore" })
}

function execRegDelete(key) {
  try {
    execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" })
  } catch {}
}
