import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { removeFileIfExists, writeTextFile } from "./shared.js"

export function enableLinuxAutostart(registration) {
  if (hasSystemdUser()) {
    const unit = buildSystemdUnit(registration)
    writeTextFile(registration.linux.systemdFile, unit)
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
    execFileSync("systemctl", ["--user", "enable", "--now", registration.linux.systemdUnit], { stdio: "ignore" })
    return {
      enabled: true,
      provider: "linux-systemd-user",
    }
  }

  const desktopFile = buildDesktopFile(registration)
  writeTextFile(registration.linux.desktopFile, desktopFile)
  return {
    enabled: true,
    provider: "linux-xdg-autostart",
  }
}

export function disableLinuxAutostart(registration) {
  if (registration && hasSystemdUser()) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", registration.linux.systemdUnit], { stdio: "ignore" })
    } catch {}
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
    } catch {}
    removeFileIfExists(registration.linux.systemdFile)
  }

  if (registration) removeFileIfExists(registration.linux.desktopFile)
  return {
    enabled: false,
    provider: hasSystemdUser() ? "linux-systemd-user" : "linux-xdg-autostart",
  }
}

export function getLinuxAutostartStatus(registration) {
  if (hasSystemdUser()) {
    try {
      const output = execFileSync("systemctl", [
        "--user",
        "status",
        registration.linux.systemdUnit,
        "--no-pager",
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return {
        enabled: true,
        provider: "linux-systemd-user",
        details: output.trim(),
      }
    } catch {}
  }

  if (existsSync(registration.linux.desktopFile)) {
    return {
      enabled: true,
      provider: "linux-xdg-autostart",
      details: readFileSync(registration.linux.desktopFile, "utf8"),
    }
  }

  return {
    enabled: false,
    provider: hasSystemdUser() ? "linux-systemd-user" : "linux-xdg-autostart",
    details: "",
  }
}

function hasSystemdUser() {
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function buildSystemdUnit(registration) {
  return `[Unit]
Description=CommandCode Go Shim

[Service]
Type=simple
ExecStart=${registration.command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

function buildDesktopFile(registration) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=CommandCode Go Shim
Comment=Starts the CommandCode local shim in background mode
Exec=${registration.command}
Terminal=false
X-GNOME-Autostart-enabled=true
`
}
