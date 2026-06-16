import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { getPaths, ensureDir } from "../config/paths.js"
import { writePid } from "../config/store.js"
import { rotateLogIfNeeded } from "../shared/log-rotation.js"
import { isProcessAlive, sleep } from "../shared/process-utils.js"

const CHECK_INTERVAL = 10000
const MAX_FAILURES = 3

/**
 * Watchdog daemon entry point.
 *
 * Receives shim config via process.argv[2] (JSON-encoded):
 *   { shimPid, host, port, token, executablePath, entryPath, dataDir }
 *
 * Periodically polls the shim /health endpoint. If MAX_FAILURES
 * consecutive checks fail, the shim is force-killed and restarted.
 */
async function runWatchdog() {
  let config
  try {
    config = JSON.parse(process.argv[2])
  } catch {
    console.error("watchdog: invalid config")
    process.exit(1)
  }

  const { shimPid, host, port, token, executablePath, entryPath } = config

  // Write watchdog PID so stopCommand can find and kill us
  const paths = getPaths()
  ensureDir(paths.dataDir)
  ensureDir(paths.logDir)
  writeWatchdogPid(process.pid)
  logWatchdog(`WATCHDOG started PID=${process.pid} monitoring shim PID=${shimPid}`)

  let currentPid = shimPid
  let failures = 0

  while (true) {
    await sleep(CHECK_INTERVAL)

    const alive = isProcessAlive(currentPid)
    const healthy = alive ? await checkHealth(host, port, token) : false

    if (healthy) {
      failures = 0
      continue
    }

    failures++
    if (failures < MAX_FAILURES) continue

    // MAX_FAILURES reached — restart the shim
    logWatchdog(`WATCHDOG restart failures=${failures} shim PID=${currentPid} unhealthy — restarting`)
    failures = 0

    // Force kill the old shim
    if (isProcessAlive(currentPid)) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/PID", String(currentPid)], {
            stdio: "ignore",
          })
        } else {
          process.kill(currentPid, "SIGKILL")
        }
      } catch {
        // Already gone
      }
    }

    // Wait for the port to be free
    await sleep(2000)

    // Spawn new shim
    const child = spawn(executablePath, [entryPath, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    currentPid = child.pid

    // Wait for it to become healthy
    const started = await waitForShimReady({ pid: currentPid, host, port, token })
    if (started) {
      writePid(currentPid)
      logWatchdog(`WATCHDOG restart OK new shim PID=${currentPid}`)
    } else {
      logWatchdog(`WATCHDOG restart FAILED new shim PID=${currentPid} did not become healthy`)
    }
  }
}

async function checkHealth(host, port, token) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      headers: {
        "x-ocg-token": token,
      },
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForShimReady({ pid, host, port, token }) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const alive = isProcessAlive(pid)
    if (!alive) return false
    const healthy = await checkHealth(host, port, token)
    if (healthy) return true
    await sleep(300)
  }
  return false
}

function writeWatchdogPid(pid) {
  const paths = getPaths()
  ensureDir(paths.dataDir)
  writeFileSync(paths.watchdogPidFile, String(pid), "utf8")
}

function logWatchdog(line) {
  const paths = getPaths()
  ensureDir(paths.logDir)
  rotateLogIfNeeded(paths.watchdogLogFile)
  appendFileSync(paths.watchdogLogFile, `[${new Date().toISOString()}] ${line}\n`)
}

// Only auto-run when executed as entry point (not when imported by tests)
runWatchdog()
