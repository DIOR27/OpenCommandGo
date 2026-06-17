import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtempSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoDir = join(__dirname, "..")
const cliEntry = join(repoDir, "bin", "ocg.js")
const cleanupTasks = []

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop()
    try {
      await task()
    } catch {
      // ignore cleanup failures in tests
    }
  }
})

describe("ocg CLI integration", () => {
  it("starts in background, syncs OpenCode config, and avoids duplicate start", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)
    seedOpenCodeConfig(ctx.paths.opencodeConfigFile)

    const first = await runCli(["start", "--background"], ctx.env)
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /OpenCommandGo launched|OpenCommandGo lanzado/i)
    assert.match(first.stdout, /Watchdog/i)

    const secrets = readJson(ctx.paths.secretsFile)
    assert.ok(secrets?.shimAccessToken, "missing shim token")

    const health = await waitForHealth(ctx.port, secrets.shimAccessToken)
    assert.equal(health?.ok, true)
    assert.equal(health?.provider, "ocg")

    const opencodeConfig = readJson(ctx.paths.opencodeConfigFile)
    const provider = opencodeConfig?.provider?.cmdshim
    assert.ok(provider, "expected provider to be synced into OpenCode config")
    assert.equal(provider.name, "OCG CommandCode")
    assert.equal(provider.options?.baseURL, `http://127.0.0.1:${ctx.port}/v1`)
    assert.equal(provider.options?.headers?.["x-ocg-token"], secrets.shimAccessToken)

    const second = await runCli(["start", "--background"], ctx.env)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /already running|ya está corriendo|ya está corriendo en/i)
  })

  it("stops shim and watchdog cleanly", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const stop = await runCli(["stop"], ctx.env)
    assert.equal(stop.code, 0, stop.stderr)
    assert.match(stop.stdout, /stopped|detenido|No process found|No hay proceso/i)

    await waitFor(async () => !existsSync(ctx.paths.pidFile))
    await waitFor(async () => !existsSync(ctx.paths.watchdogPidFile))

    const healthAfterStop = await probeHealth(ctx.port, secrets.shimAccessToken)
    assert.equal(healthAfterStop, null)
  })

  it("shows shim/watchdog logs and follows appended lines", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const shimLogs = await runCli(["logs", "--lines", "5"], ctx.env)
    assert.equal(shimLogs.code, 0, shimLogs.stderr)
    assert.match(shimLogs.stdout, /Log:/i)
    assert.match(shimLogs.stdout, /LISTEN|COMPAT/i)

    const watchdogLogs = await runCli(["logs", "--watchdog", "--lines", "5"], ctx.env)
    assert.equal(watchdogLogs.code, 0, watchdogLogs.stderr)
    assert.match(watchdogLogs.stdout, /Watchdog log|Watchdog/i)
    assert.match(watchdogLogs.stdout, /WATCHDOG started/i)

    const follower = spawn(process.execPath, [cliEntry, "logs", "--watchdog", "--follow", "--lines", "1"], {
      cwd: repoDir,
      env: { ...process.env, ...ctx.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    cleanupTasks.push(async () => killChildProcess(follower))

    let stdout = ""
    follower.stdout.on("data", chunk => {
      stdout += String(chunk)
    })

    await waitFor(() => stdout.includes("Following") || stdout.includes("Siguiendo"))
    appendFileSync(ctx.paths.watchdogLogFile, `[${new Date().toISOString()}] WATCHDOG test follow line\n`, "utf8")
    await waitFor(() => stdout.includes("WATCHDOG test follow line"))
    await killChildProcess(follower)
  })

  it("restores the shim after a crash through watchdog recovery", { timeout: 25000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const originalPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
    assert.ok(originalPid > 0, "expected shim pid")

    killPid(originalPid)

    await waitFor(async () => {
      if (!existsSync(ctx.paths.pidFile)) return false
      const nextPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
      if (!Number.isInteger(nextPid) || nextPid <= 0 || nextPid === originalPid) return false
      const health = await probeHealth(ctx.port, secrets.shimAccessToken)
      return health?.ok === true
    }, { timeoutMs: 15000, intervalMs: 250 })

    const restartedPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
    assert.notEqual(restartedPid, originalPid)

    const watchdogLog = readFileSync(ctx.paths.watchdogLogFile, "utf8")
    assert.match(watchdogLog, /WATCHDOG restart OK/i)
  })
})

function createIsolatedCliContext(port, mockPort) {
  const root = mkdtempSync(join(tmpdir(), "ocg-integration-"))
  const userProfile = join(root, "user")
  mkdirSync(userProfile, { recursive: true })

  return {
    root,
    port,
    env: {
      OCG_HOME: root,
      USERPROFILE: userProfile,
      COMMANDCODE_API_KEY: "test-commandcode-key",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${mockPort}`,
      SHIM_PORT: String(port),
      OCG_WATCHDOG_INTERVAL_MS: "250",
      OCG_WATCHDOG_MAX_FAILURES: "2",
      OCG_WATCHDOG_RESTART_DELAY_MS: "250",
      OCG_WATCHDOG_READY_TIMEOUT_MS: "2500",
    },
    paths: {
      dataDir: join(root, "ocg"),
      secretsFile: join(root, "ocg", "secrets.json"),
      pidFile: join(root, "ocg", "shim.pid"),
      watchdogPidFile: join(root, "ocg", "watchdog.pid"),
      logFile: join(root, "ocg", "logs", "shim.log"),
      watchdogLogFile: join(root, "ocg", "logs", "watchdog.log"),
      opencodeConfigFile: join(userProfile, ".config", "opencode", "opencode.json"),
    },
  }
}

function seedOpenCodeConfig(file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2), "utf8")
}

function registerCleanup(ctx, mock) {
  cleanupTasks.push(async () => {
    try {
      await runCli(["stop"], ctx.env, { timeoutMs: 8000 })
    } catch {
      // ignore
    }
    killPid(readPidFile(ctx.paths.pidFile))
    killPid(readPidFile(ctx.paths.watchdogPidFile))
    rmSync(ctx.root, { recursive: true, force: true })
    await mock.close()
  })
}

function readPidFile(file) {
  if (!existsSync(file)) return null
  const value = Number(readFileSync(file, "utf8").trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

async function runCli(args, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""

    const timer = setTimeout(() => {
      killChildProcess(child).finally(() => reject(new Error(`CLI timeout: ${args.join(" ")}`)))
    }, timeoutMs)

    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", chunk => {
      stderr += String(chunk)
    })
    child.on("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function waitForHealth(port, token) {
  let last = null
  await waitFor(async () => {
    last = await probeHealth(port, token)
    return last?.ok === true
  }, { timeoutMs: 12000, intervalMs: 250 })
  return last
}

async function probeHealth(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-ocg-token": token },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  throw new Error("Timed out waiting for condition")
}

async function startMockCatalogServer() {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/provider/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: [
          {
            id: "xiaomi/MiMo-V2.5",
            display_name: "MiMo V2.5",
            context_length: 200000,
            capabilities: {
              vision: true,
              pdf: true,
              audio: true,
              video: true,
            },
            tags: ["reasoning"],
          },
        ],
      }))
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function getFreePort() {
  const server = createServer((_, res) => {
    res.writeHead(204)
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return address.port
}

function killPid(pid) {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    // ignore
  }
}

async function killChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    // ignore
  }
  await new Promise(resolve => child.once("close", resolve))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}
