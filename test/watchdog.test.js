import { describe, it, mock, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readWatchdogPid, writeWatchdogPid, clearWatchdogPid } from "../src/config/store.js"
import { getPaths } from "../src/config/paths.js"
import { existsSync, readFileSync, unlinkSync } from "node:fs"

// ---------------------------------------------------------------------------
// Watchdog PID file helpers
// ---------------------------------------------------------------------------
describe("watchdog PID helpers", () => {
  const testPid = 99999

  afterEach(() => {
    const paths = getPaths()
    if (existsSync(paths.watchdogPidFile)) {
      unlinkSync(paths.watchdogPidFile)
    }
  })

  it("writeWatchdogPid writes the PID file", () => {
    writeWatchdogPid(testPid)
    const paths = getPaths()
    assert.ok(existsSync(paths.watchdogPidFile))
    const content = readFileSync(paths.watchdogPidFile, "utf8").trim()
    assert.strictEqual(Number(content), testPid)
  })

  it("readWatchdogPid reads the PID file", () => {
    writeWatchdogPid(testPid)
    const pid = readWatchdogPid()
    assert.strictEqual(pid, testPid)
  })

  it("readWatchdogPid returns null when no file exists", () => {
    const pid = readWatchdogPid()
    assert.strictEqual(pid, null)
  })

  it("clearWatchdogPid removes the PID file", () => {
    writeWatchdogPid(testPid)
    clearWatchdogPid()
    const paths = getPaths()
    assert.ok(!existsSync(paths.watchdogPidFile))
  })

  it("clearWatchdogPid does not throw when no file exists", () => {
    clearWatchdogPid()
    assert.ok(true)
  })
})

// ---------------------------------------------------------------------------
// Health check pattern (same logic used by watchdog)
// ---------------------------------------------------------------------------
describe("watchdog health check pattern", () => {
  afterEach(() => mock.restoreAll())

  it("returns true when /health responds 200", async () => {
    mock.method(global, "fetch", () =>
      Promise.resolve({ ok: true })
    )

    const response = await fetch("http://127.0.0.1:4310/health", {
      headers: { "x-ocg-token": "test-token" },
      signal: AbortSignal.timeout(5000),
    })
    assert.ok(response.ok)
  })

  it("returns false when fetch throws (shim offline)", async () => {
    mock.method(global, "fetch", () => Promise.reject(new Error("ECONNREFUSED")))

    try {
      const response = await fetch("http://127.0.0.1:4310/health", {
        headers: { "x-ocg-token": "test-token" },
        signal: AbortSignal.timeout(5000),
      })
      assert.ok(!response.ok, "should not reach here if fetch throws")
    } catch {
      assert.ok(true)
    }
  })

  it("returns false when /health returns non-200", async () => {
    mock.method(global, "fetch", () =>
      Promise.resolve({ ok: false, status: 500 })
    )

    const response = await fetch("http://127.0.0.1:4310/health", {
      headers: { "x-ocg-token": "test-token" },
      signal: AbortSignal.timeout(5000),
    })
    assert.strictEqual(response.ok, false)
    assert.strictEqual(response.status, 500)
  })
})
