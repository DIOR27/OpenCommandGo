import { existsSync, readFileSync } from "node:fs"
import { removeFileIfExists, writeTextFile } from "./shared.js"

export function enableWindowsAutostart(registration) {
  const script = `@echo off
${registration.command}
`
  writeTextFile(registration.windows.startupFile, script)
  return {
    enabled: true,
    provider: "windows-startup-folder",
  }
}

export function disableWindowsAutostart(registration) {
  removeFileIfExists(registration.windows.startupFile)
  return {
    enabled: false,
    provider: "windows-startup-folder",
  }
}

export function getWindowsAutostartStatus(registration) {
  if (!existsSync(registration.windows.startupFile)) {
    return {
      enabled: false,
      provider: "windows-startup-folder",
      details: "",
    }
  }

  return {
    enabled: true,
    provider: "windows-startup-folder",
    details: readFileSync(registration.windows.startupFile, "utf8"),
  }
}
