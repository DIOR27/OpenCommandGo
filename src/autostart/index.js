import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { readConfig, writeConfig } from "../config/store.js"
import { disableLinuxAutostart, enableLinuxAutostart, getLinuxAutostartStatus } from "./linux.js"
import { disableMacAutostart, enableMacAutostart, getMacAutostartStatus } from "./macos.js"
import { disableWindowsAutostart, enableWindowsAutostart, getWindowsAutostartStatus } from "./windows.js"

const APP_LABEL = "commandcode-go-shim"
const TASK_NAME = "CommandCode Shim"
const MACOS_PLIST_LABEL = "ai.commandcode.go.shim"
const LINUX_SYSTEMD_UNIT = "commandcode-go-shim.service"
const LINUX_DESKTOP_FILE = "commandcode-go-shim.desktop"

export async function enableAutostart() {
  const registration = resolveRegistration()
  const result =
    process.platform === "win32" ? enableWindowsAutostart(registration)
      : process.platform === "darwin" ? enableMacAutostart(registration)
        : enableLinuxAutostart(registration)

  persistAutostartState({
    enabled: true,
    provider: result.provider,
    scope: "user",
    mode: "logon",
  })
  return result
}

export async function disableAutostart() {
  const registration = resolveRegistration()
  const result =
    process.platform === "win32" ? disableWindowsAutostart(registration)
      : process.platform === "darwin" ? disableMacAutostart(registration)
        : disableLinuxAutostart(registration)

  persistAutostartState({
    enabled: false,
    provider: result.provider || null,
    scope: "user",
    mode: "logon",
  })
  return result
}

export async function getAutostartStatus() {
  const registration = resolveRegistration()
  const platformStatus =
    process.platform === "win32" ? getWindowsAutostartStatus(registration)
      : process.platform === "darwin" ? getMacAutostartStatus(registration)
        : getLinuxAutostartStatus(registration)

  const config = readConfig()
  return {
    enabled: Boolean(platformStatus.enabled),
    provider: platformStatus.provider,
    scope: "user",
    mode: "logon",
    command: registration.command,
    registration,
    config: config.autostart || null,
    matchesConfig:
      Boolean(platformStatus.enabled) === Boolean(config.autostart?.enabled)
      && String(platformStatus.provider || "") === String(config.autostart?.provider || ""),
    details: platformStatus.details || "",
  }
}

export function resolveRegistration() {
  const launcher = resolveLauncher()
  return {
    appLabel: APP_LABEL,
    command: launcher.command,
    commandArgs: launcher.argv,
    taskExecute: launcher.taskExecute || null,
    taskArguments: launcher.taskArguments || "",
    windowsTaskName: TASK_NAME,
    windows: {
      startupFile: join(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        `${APP_LABEL}.cmd`,
      ),
    },
    macos: {
      label: MACOS_PLIST_LABEL,
      plistFile: join(homedir(), "Library", "LaunchAgents", `${MACOS_PLIST_LABEL}.plist`),
    },
    linux: {
      systemdUnit: LINUX_SYSTEMD_UNIT,
      systemdFile: join(homedir(), ".config", "systemd", "user", LINUX_SYSTEMD_UNIT),
      desktopFile: join(resolveXdgConfigHome(), "autostart", LINUX_DESKTOP_FILE),
    },
  }
}

function resolveLauncher() {
  const candidates =
    process.platform === "win32"
      ? [
          ...resolveFromWhere("ccga"),
          ...resolveFromWhere("commandcode-shim"),
          ...resolveFromWhere("commandcode-go-around"),
        ]
      : [
          ...resolveFromShell("ccga"),
          ...resolveFromShell("commandcode-shim"),
          ...resolveFromShell("commandcode-go-around"),
        ]

  const chosen = chooseBestLauncher(candidates)
  if (chosen) return chosen

  throw new Error("No pude resolver el ejecutable del CLI para registrar autostart.")
}

function chooseBestLauncher(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  if (process.platform === "win32") {
    const cmd = candidates.find(entry => /\.cmd$/i.test(entry.path))
    if (cmd) {
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
      const inner = `"${cmd.path}" start --background`
      return {
        command: `"${comspec}" /d /s /c "${inner}"`,
        argv: [comspec, "/d", "/s", "/c", inner],
        taskExecute: comspec,
        taskArguments: `/d /s /c "${inner}"`,
        executable: cmd.path,
      }
    }
    const executable = candidates[0]
    return {
      command: `"${executable.path}" start --background`,
      argv: [executable.path, "start", "--background"],
      taskExecute: executable.path,
      taskArguments: "start --background",
      executable: executable.path,
    }
  }

  const executable = candidates[0]
  return {
    command: `"${executable.path}" start --background`,
    argv: [executable.path, "start", "--background"],
    executable: executable.path,
  }
}

function resolveFromWhere(command) {
  try {
    return execFileSync("where", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(existsSync)
      .map(path => ({ path }))
  } catch {
    return []
  }
}

function resolveFromShell(command) {
  try {
    const path = execFileSync("sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return path && existsSync(path) ? [{ path }] : []
  } catch {
    return []
  }
}

function persistAutostartState(nextAutostart) {
  const config = readConfig()
  config.autostart = {
    ...(config.autostart || {}),
    ...nextAutostart,
  }
  writeConfig(config)
}

function resolveXdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}
