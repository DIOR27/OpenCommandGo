import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { countWatchdogRestarts, parseRefreshModelsArgs, readTail } from "../src/cli/main.js"

describe("parseRefreshModelsArgs", () => {
  it("parses --full, --parallel and --yes together", () => {
    const parsed = parseRefreshModelsArgs(["--full", "--parallel", "2", "--yes"])
    assert.deepStrictEqual(parsed, {
      full: true,
      concurrency: 2,
      yes: true,
      probe: true,
      provider: "all",
      showModels: false,
    })
  })

  it("parses alias flags and inline concurrency", () => {
    const parsed = parseRefreshModelsArgs(["--verify", "--concurrency=6"])
    assert.deepStrictEqual(parsed, {
      full: false,
      concurrency: 6,
      yes: false,
      probe: true,
      provider: "all",
      showModels: false,
    })
  })

  it("ignores invalid concurrency values", () => {
    const parsed = parseRefreshModelsArgs(["--probe", "--parallel", "0"])
    assert.deepStrictEqual(parsed, {
      full: false,
      concurrency: undefined,
      yes: false,
      probe: true,
      provider: "all",
      showModels: false,
    })
  })

  it("parses explicit provider selection", () => {
    const parsed = parseRefreshModelsArgs(["--provider", "openrouter", "--probe"])
    assert.deepStrictEqual(parsed, {
      full: false,
      concurrency: undefined,
      yes: false,
      probe: true,
      provider: "openrouter",
      showModels: false,
    })
  })

  it("parses show-models flag", () => {
    const parsed = parseRefreshModelsArgs(["--show-models"])
    assert.deepStrictEqual(parsed, {
      full: false,
      concurrency: undefined,
      yes: false,
      probe: false,
      provider: "all",
      showModels: true,
    })
  })
})

describe("readTail", () => {
  it("returns the requested last N lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocg-cli-test-"))
    const file = join(dir, "shim.log")
    try {
      writeFileSync(file, "a\nb\nc\nd\n", "utf8")
      assert.deepStrictEqual(readTail(file, 2), ["d", ""])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("countWatchdogRestarts", () => {
  it("counts successful restart markers in watchdog logs", () => {
    const content = [
      "[ts] WATCHDOG started PID=1 monitoring shim PID=2",
      "[ts] WATCHDOG restart OK new shim PID=3",
      "[ts] WATCHDOG restart FAILED new shim PID=4 did not become healthy",
      "[ts] WATCHDOG restart OK new shim PID=5",
    ].join("\n")

    assert.strictEqual(countWatchdogRestarts(content), 2)
  })
})
