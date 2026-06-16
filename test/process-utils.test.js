import { describe, it, mock, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  isProcessAlive,
  sleep,
  findPidByPort,
  gracefulKill,
} from "../src/shared/process-utils.js"

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------
describe("isProcessAlive", () => {
  afterEach(() => mock.restoreAll())

  it("returns true when process.kill(pid, 0) succeeds", () => {
    mock.method(process, "kill", () => {})
    assert.strictEqual(isProcessAlive(42), true)
  })

  it("returns false when process.kill(pid, 0) throws", () => {
    mock.method(process, "kill", () => {
      throw new Error("ESRCH")
    })
    assert.strictEqual(isProcessAlive(42), false)
  })

  it("passes signal 0 to process.kill", () => {
    const mockKill = mock.method(process, "kill", () => {})
    isProcessAlive(99)
    assert.strictEqual(mockKill.mock.calls[0].arguments[0], 99)
    assert.strictEqual(mockKill.mock.calls[0].arguments[1], 0)
  })
})

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
describe("sleep", () => {
  it("resolves after the specified ms", async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 40, `Expected >=40ms, got ${elapsed}ms`)
  })
})

// ---------------------------------------------------------------------------
// findPidByPort (Windows code path)
// ---------------------------------------------------------------------------
describe("findPidByPort - Windows", () => {
  it("returns PID from PowerShell Get-NetTCPConnection output", () => {
    const mockExec = (cmd) => {
      if (cmd === "powershell") return "12345\n"
      return ""
    }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, 12345)
  })

  it("falls back to netstat when PowerShell fails", () => {
    const mockExec = (cmd) => {
      if (cmd === "powershell") throw new Error("not found")
      if (cmd === "netstat") {
        return [
          "  TCP    127.0.0.1:4310    0.0.0.0:0    LISTENING    67890",
          "  TCP    127.0.0.1:5432    0.0.0.0:0    LISTENING    11111",
        ].join("\n")
      }
      return ""
    }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, 67890)
  })

  it("returns null when no process is listening on the port", () => {
    const mockExec = (cmd) => {
      if (cmd === "powershell") throw new Error("not found")
      if (cmd === "netstat") return ""
      return ""
    }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, null)
  })

  it("returns null when execFileSync throws entirely", () => {
    const mockExec = () => { throw new Error("EPERM") }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, null)
  })

  it("discards non-numeric PowerShell output", () => {
    const mockExec = (cmd) => {
      if (cmd === "powershell") return "\n\nnot-a-number\n"
      return ""
    }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, null)
  })

  it("matches correct port from netstat output with multiple entries", () => {
    const mockExec = (cmd) => {
      if (cmd === "powershell") throw new Error("not found")
      if (cmd === "netstat") {
        return [
          "  TCP    0.0.0.0:135     0.0.0.0:0    LISTENING    1111",
          "  TCP    0.0.0.0:445     0.0.0.0:0    LISTENING    2222",
          "  TCP    127.0.0.1:4310  0.0.0.0:0    LISTENING    77777",
          "  TCP    127.0.0.1:5040  0.0.0.0:0    LISTENING    8888",
        ].join("\n")
      }
      return ""
    }
    const pid = findPidByPort(4310, { execFileSync: mockExec })
    assert.strictEqual(pid, 77777)
  })
})

// ---------------------------------------------------------------------------
// gracefulKill
// ---------------------------------------------------------------------------
describe("gracefulKill", () => {
  afterEach(() => mock.restoreAll())

  it("returns true if process is already dead", async () => {
    mock.method(process, "kill", () => { throw new Error("ESRCH") })
    const result = await gracefulKill(42)
    assert.strictEqual(result, true)
  })

  it("Phase 0: attempts /shutdown endpoint when shutdownUrl is provided", async () => {
    const mockFetch = mock.method(global, "fetch", () =>
      Promise.resolve({ ok: true })
    )

    let callCount = 0
    mock.method(process, "kill", () => {
      callCount++
      if (callCount <= 1) return
      throw new Error("ESRCH")
    })

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      shutdownUrl: "http://127.0.0.1:4310/shutdown",
      shutdownToken: "test-token",
    })
    assert.strictEqual(result, true)

    assert.ok(mockFetch.mock.calls.length >= 1)
    assert.strictEqual(
      mockFetch.mock.calls[0].arguments[0],
      "http://127.0.0.1:4310/shutdown"
    )
  })

  it("Phase 0: falls through to Phase 1+2 when /shutdown fails", async () => {
    mock.method(global, "fetch", () => Promise.reject(new Error("ECONNREFUSED")))

    mock.method(process, "kill", () => {})

    let forceKillCalled = false
    const mockExec = (cmd, args) => {
      if (cmd === "taskkill" && args && args[0] === "/F") {
        forceKillCalled = true
        return ""
      }
      return ""
    }

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      execFileSync: mockExec,
      shutdownUrl: "http://127.0.0.1:4310/shutdown",
      shutdownToken: "test-token",
    })
    assert.strictEqual(result, false)
    assert.strictEqual(forceKillCalled, true)
  })

  it("Phase 0: returns true when /shutdown succeeds and process dies", async () => {
    mock.method(global, "fetch", () => Promise.resolve({ ok: true }))

    let callCount = 0
    mock.method(process, "kill", () => {
      callCount++
      if (callCount <= 1) return
      throw new Error("ESRCH")
    })

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      shutdownUrl: "http://127.0.0.1:4310/shutdown",
      shutdownToken: "test-token",
    })
    assert.strictEqual(result, true)
  })

  it("Phase 0: sends x-ocg-token header in /shutdown request", async () => {
    let capturedHeaders = null
    mock.method(global, "fetch", (url, opts) => {
      capturedHeaders = opts.headers
      return Promise.resolve({ ok: true })
    })

    let callCount = 0
    mock.method(process, "kill", () => {
      callCount++
      if (callCount <= 1) return
      throw new Error("ESRCH")
    })

    await gracefulKill(42, {
      timeoutMs: 100,
      shutdownUrl: "http://127.0.0.1:4310/shutdown",
      shutdownToken: "my-token-123",
    })

    assert.ok(capturedHeaders)
    assert.strictEqual(capturedHeaders["x-ocg-token"], "my-token-123")
  })

  it("Phase 1: sends taskkill /PID, returns true on graceful exit", async () => {
    let callCount = 0
    mock.method(process, "kill", () => {
      callCount++
      if (callCount <= 1) return
      throw new Error("ESRCH")
    })

    const mockExec = (cmd) => {
      if (cmd === "taskkill") return ""
      return ""
    }

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      execFileSync: mockExec,
    })
    assert.strictEqual(result, true)
  })

  it("Phase 2: force kills with taskkill /F when graceful timeout expires", async () => {
    let alive = true
    mock.method(process, "kill", () => {
      if (!alive) throw new Error("ESRCH")
    })

    let forceKillCalled = false
    let forceTimeoutCalled = false

    const mockExec = (cmd, args) => {
      if (cmd === "taskkill" && args && args[0] === "/F") {
        forceKillCalled = true
        alive = false
        return ""
      }
      return ""
    }

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      onForceTimeout: () => { forceTimeoutCalled = true },
      execFileSync: mockExec,
    })
    assert.strictEqual(result, true)
    assert.strictEqual(forceKillCalled, true)
    assert.strictEqual(forceTimeoutCalled, true)
  })

  it("returns false if both graceful and force kill fail", async () => {
    mock.method(process, "kill", () => {})
    const mockExec = () => { throw new Error("access denied") }

    const result = await gracefulKill(42, {
      timeoutMs: 100,
      execFileSync: mockExec,
    })
    assert.strictEqual(result, false)
  })
})
