import { execFileSync } from "node:child_process"

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function findPidByPort(port, { execFileSync: _exec, platform: _platform } = {}) {
  const exec = _exec || execFileSync
  const platform = _platform || process.platform
  try {
    if (platform === "win32") {
      // Try PowerShell Get-NetTCPConnection first (cleaner output)
      try {
        const result = exec(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`,
          ],
          { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
        )
        const pid = Number(String(result || "").trim())
        if (Number.isInteger(pid) && pid > 0) return pid
      } catch {
        // Fall through to netstat
      }

      // Fallback: parse netstat -ano output
      const netstat = exec("netstat", ["-ano"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      for (const line of netstat.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (
          parts.length >= 5
          && parts[0].toLowerCase().startsWith("tcp")
          && parts[3].toLowerCase().includes("listen")
        ) {
          const address = parts[1]
          const colonIdx = address.lastIndexOf(":")
          if (colonIdx >= 0) {
            const linePort = address.slice(colonIdx + 1)
            if (Number(linePort) === port) {
              const pid = Number(parts[4])
              if (Number.isInteger(pid) && pid > 0) return pid
            }
          }
        }
      }
    } else {
      // Unix: lsof -ti tcp:{port}
      try {
        const result = exec(
          "lsof",
          ["-ti", `tcp:${port}`],
          { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
        )
        const pid = Number(String(result || "").trim())
        if (Number.isInteger(pid) && pid > 0) return pid
      } catch {
        // Fall through to ss
      }

      // Fallback: ss -tlnp
      try {
        const result = exec(
          "ss",
          ["-tlnp", `sport = :${port}`],
          { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
        )
        for (const line of result.split("\n")) {
          const match = line.match(/pid=(\d+)/)
          if (match) {
            const pid = Number(match[1])
            if (Number.isInteger(pid) && pid > 0) return pid
          }
        }
      } catch {
        // Not found
      }
    }
  } catch {
    // Unable to scan
  }
  return null
}

export async function gracefulKill(pid, { timeoutMs = 3000, onForceTimeout, execFileSync: _exec, shutdownUrl, shutdownToken } = {}) {
  const exec = _exec || execFileSync
  if (!isProcessAlive(pid)) return true

  // Phase 0: try HTTP /shutdown endpoint first
  if (shutdownUrl && shutdownToken) {
    try {
      const response = await fetch(shutdownUrl, {
        method: "POST",
        headers: {
          "x-ocg-token": shutdownToken,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) {
        // Wait for the process to exit after receiving shutdown signal
        await sleep(1500)
        if (!isProcessAlive(pid)) return true
      }
    } catch {
      // /shutdown not available or failed — fall through
    }
  }

  // Phase 1: graceful shutdown (taskkill /PID or SIGTERM)
  try {
    if (process.platform === "win32") {
      exec("taskkill", ["/PID", String(pid)], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } else {
      process.kill(pid, "SIGTERM")
    }
  } catch {
    // Process might already be gone
  }

  // Wait up to timeoutMs for graceful exit
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(200)
    if (!isProcessAlive(pid)) return true
  }

  // Phase 2: force kill
  if (typeof onForceTimeout === "function") onForceTimeout()
  try {
    if (process.platform === "win32") {
      exec("taskkill", ["/F", "/PID", String(pid)], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    // Process might already be gone
  }

  await sleep(500)
  return !isProcessAlive(pid)
}
