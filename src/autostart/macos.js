import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { removeFileIfExists, writeTextFile } from "./shared.js"

export function enableMacAutostart(registration) {
  const plist = buildPlist(registration)
  writeTextFile(registration.macos.plistFile, plist)
  try {
    execFileSync("launchctl", ["unload", registration.macos.plistFile], { stdio: "ignore" })
  } catch {}
  execFileSync("launchctl", ["load", "-w", registration.macos.plistFile], { stdio: "ignore" })
  return {
    enabled: true,
    provider: "macos-launchagent",
  }
}

export function disableMacAutostart(registration) {
  try {
    execFileSync("launchctl", ["unload", "-w", registration.macos.plistFile], { stdio: "ignore" })
  } catch {}
  removeFileIfExists(registration.macos.plistFile)
  return {
    enabled: false,
    provider: "macos-launchagent",
  }
}

export function getMacAutostartStatus(registration) {
  if (!existsSync(registration.macos.plistFile)) {
    return {
      enabled: false,
      provider: "macos-launchagent",
      details: "",
    }
  }
  return {
    enabled: true,
    provider: "macos-launchagent",
    details: readFileSync(registration.macos.plistFile, "utf8"),
  }
}

function buildPlist(registration) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${registration.macos.label}</string>
    <key>ProgramArguments</key>
    <array>
      ${registration.commandArgs.map(arg => `<string>${escapeXml(arg)}</string>`).join("\n      ")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
  </dict>
</plist>
`
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
