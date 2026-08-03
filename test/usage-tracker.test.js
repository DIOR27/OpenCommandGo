import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatUsageLine, parseUsage } from "../src/runtime/usage-tracker.js"

describe("parseUsage with real cmd v1.9.0 /usage output", () => {
  const REAL_OUTPUT = [
    "USAGE  Go Plan · active",
    "",
    "█░░░░░░░░░ 4% used",
    "Cycle: $9.55 left · 360 requests · 30 days to renewal",
    "",
    "Usage limits",
    "5-hour  █░░░░░░░░░ 1% · resets in 4h 58m",
    "",
    "Weekly  ██░░░░░░░░ 21% · resets in 15h 55m",
    "",
    "Full breakdown at commandcode.ai/dior27/settings/usage",
  ].join("\n")

  it("parses plan, cycle balance, requests, renewal, and usage limits", () => {
    const parsed = parseUsage(REAL_OUTPUT)
    assert.ok(parsed, "parseUsage must return a result for the real output shape")
    assert.equal(parsed.plan, "Go Plan")
    assert.equal(parsed.cycleLeft, 9.55)
    assert.equal(parsed.requestsLeft, 360)
    assert.equal(parsed.daysToRenewal, 30)
    assert.equal(parsed.usedPercent, 4)
    assert.equal(parsed.fiveHourPercent, 1)
    assert.equal(parsed.weeklyPercent, 21)
  })

  it("formatUsageLine renders a compact status line", () => {
    const parsed = parseUsage(REAL_OUTPUT)
    const line = formatUsageLine(parsed)
    assert.ok(line, "formatUsageLine must render when parsed")
    assert.match(line, /Go Plan/)
    assert.match(line, /\$9\.55 left/)
    assert.match(line, /360 reqs/)
    assert.match(line, /30d/)
    assert.match(line, /weekly 21%/)
    assert.match(line, /5h 1%/)
  })

  it("returns null for output without a cycle line (trust prompt, loading, errors)", () => {
    assert.equal(parseUsage("Do you trust the files in this folder?"), null)
    assert.equal(parseUsage("USAGE\nLoading…\n\nPress Esc to close"), null)
    assert.equal(parseUsage(""), null)
    assert.equal(parseUsage(null), null)
  })

  it("handles ANSI escape sequences in real terminal output", () => {
    const withAnsi = "\x1b[?2004h" + REAL_OUTPUT + "\x1b[?2026l"
    const parsed = parseUsage(withAnsi)
    assert.ok(parsed, "stripAnsi must remove escape sequences before matching")
    assert.equal(parsed.cycleLeft, 9.55)
  })
})
