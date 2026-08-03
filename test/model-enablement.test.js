import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirname } from "node:path"
import { getPaths } from "../src/config/paths.js"
import {
  filterEnabledModels,
  readEnablement,
  resetEnablement,
  resolveEnabled,
  setEnabled,
  toggleEnablement,
} from "../src/config/model-enablement.js"
import { deriveCatalogTier, isPremiumFamily } from "../src/shared/catalog-tier.js"
import { buildCmdCatalogRows } from "../src/shared/commandcode-cmd-catalog.js"

const ORIGINAL_OCG_HOME = process.env.OCG_HOME

describe("model enablement store", () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocg-enablement-"))
    process.env.OCG_HOME = root
  })

  afterEach(() => {
    if (ORIGINAL_OCG_HOME === undefined) delete process.env.OCG_HOME
    else process.env.OCG_HOME = ORIGINAL_OCG_HOME
    rmSync(root, { recursive: true, force: true })
  })

  it("absent file defaults to empty enabled map and does not force a write", () => {
    const store = readEnablement()
    assert.deepStrictEqual(store.enabled, {})
    assert.equal(
      existsSync(getPaths().enablementFile),
      false,
      "reading a missing store must not create the file",
    )
  })

  it("setEnabled(true) persists an explicit entry that reloads", () => {
    setEnabled("anthropic/claude-sonnet-5", true)

    assert.ok(existsSync(getPaths().enablementFile), "setEnabled must write the store file")
    const parsed = JSON.parse(readFileSync(getPaths().enablementFile, "utf8"))
    assert.equal(parsed.enabled["anthropic/claude-sonnet-5"], true)

    const reloaded = readEnablement()
    assert.equal(reloaded.enabled["anthropic/claude-sonnet-5"], true)
  })

  it("setEnabled(false) persists an explicit false that overrides the open-source default", () => {
    setEnabled("deepseek/deepseek-v4-flash", false)

    const parsed = JSON.parse(readFileSync(getPaths().enablementFile, "utf8"))
    assert.equal(parsed.enabled["deepseek/deepseek-v4-flash"], false)
    assert.equal(
      resolveEnabled("deepseek/deepseek-v4-flash", "open-source", readEnablement()),
      false,
      "explicit false must beat the open-source default",
    )
  })

  it("toggleEnablement flips the persisted flag and reloads reflect it", () => {
    toggleEnablement("anthropic/claude-sonnet-5")
    assert.equal(
      resolveEnabled("anthropic/claude-sonnet-5", "premium", readEnablement()),
      true,
      "first toggle on a default-disabled premium model enables it",
    )

    toggleEnablement("anthropic/claude-sonnet-5")
    assert.equal(
      resolveEnabled("anthropic/claude-sonnet-5", "premium", readEnablement()),
      false,
      "second toggle disables it again",
    )
  })

  it("first toggle on a default-enabled open-source model disables it (tier-aware)", () => {
    toggleEnablement("deepseek/deepseek-v4-flash", "open-source")
    assert.equal(
      resolveEnabled("deepseek/deepseek-v4-flash", "open-source", readEnablement()),
      false,
      "first toggle must disable a default-enabled open-source model, not write true",
    )

    toggleEnablement("deepseek/deepseek-v4-flash", "open-source")
    assert.equal(
      resolveEnabled("deepseek/deepseek-v4-flash", "open-source", readEnablement()),
      true,
      "second toggle re-enables it",
    )
  })

  it("toggleEnablement derives tier by family heuristic when no tier is passed", () => {
    toggleEnablement("deepseek/deepseek-v4-flash")
    assert.equal(
      resolveEnabled("deepseek/deepseek-v4-flash", "open-source", readEnablement()),
      false,
      "family heuristic must treat deepseek as open-source (default enabled)",
    )

    toggleEnablement("claude-sonnet-5")
    assert.equal(
      resolveEnabled("claude-sonnet-5", "premium", readEnablement()),
      true,
      "family heuristic must treat claude as premium (default disabled)",
    )
  })

  it("resetEnablement removes the store file and restores defaults", () => {
    setEnabled("anthropic/claude-sonnet-5", true)
    assert.ok(existsSync(getPaths().enablementFile))

    resetEnablement()
    assert.equal(existsSync(getPaths().enablementFile), false)
    assert.deepStrictEqual(readEnablement().enabled, {})
  })

  it("corrupt JSON falls back to defaults, surfaces a warning, and never crashes", () => {
    mkdirSync(dirname(getPaths().enablementFile), { recursive: true })
    writeFileSync(getPaths().enablementFile, "{not-json", "utf8")
    const warn = mock.method(console, "warn", () => {})

    const store = readEnablement()
    assert.deepStrictEqual(store.enabled, {}, "corrupt store must fall back to defaults")
    assert.ok(warn.mock.calls.length > 0, "corrupt store must surface a warning")
    warn.mock.restore()
  })

  it("resolveEnabled matrix: explicit wins, open-source defaults enabled, premium defaults disabled", () => {
    const store = { enabled: { "openai/gpt-5": true, "anthropic/claude-sonnet-5": false } }

    assert.equal(resolveEnabled("openai/gpt-5", "premium", store), true, "explicit true wins")
    assert.equal(resolveEnabled("anthropic/claude-sonnet-5", "premium", store), false, "explicit false wins")
    assert.equal(
      resolveEnabled("deepseek/deepseek-v4-flash", "open-source", store),
      true,
      "open-source model without an entry is enabled by default",
    )
    assert.equal(
      resolveEnabled("anthropic/claude-haiku", "premium", store),
      false,
      "premium model without an entry is disabled by default",
    )
    assert.equal(
      resolveEnabled("anthropic/claude-haiku", "premium", undefined),
      false,
      "missing store behaves like defaults",
    )
  })

  it("filterEnabledModels keeps only models resolveEnabled says are enabled", () => {
    const rows = [
      { id: "deepseek/deepseek-v4-flash", tier: "open-source" },
      { id: "anthropic/claude-sonnet-5", tier: "premium" },
      { id: "anthropic/claude-opus", tier: "premium" },
    ]
    const store = { enabled: { "anthropic/claude-opus": true } }

    const enabled = filterEnabledModels(rows, store)
    assert.deepStrictEqual(
      enabled.map(row => row.id),
      ["deepseek/deepseek-v4-flash", "anthropic/claude-opus"],
      "open-source default + explicitly enabled premium survive; disabled premium does not",
    )
  })

  it("filterEnabledModels with no store keeps only open-source rows", () => {
    const rows = [
      { id: "deepseek/deepseek-v4-flash", tier: "open-source" },
      { id: "anthropic/claude-sonnet-5", tier: "premium" },
    ]
    const enabled = filterEnabledModels(rows, undefined)
    assert.deepStrictEqual(enabled.map(row => row.id), ["deepseek/deepseek-v4-flash"])
  })
})

describe("catalog tier derivation", () => {
  it("isPremiumFamily flags claude/gpt/o1/o3/o4/codex families as premium", () => {
    assert.equal(isPremiumFamily("anthropic/claude-sonnet-5"), true)
    assert.equal(isPremiumFamily("claude-3-5-sonnet"), true)
    assert.equal(isPremiumFamily("openai/gpt-5"), true)
    assert.equal(isPremiumFamily("openai/o3"), true)
    assert.equal(isPremiumFamily("openai/codex-mini"), true)
  })

  it("isPremiumFamily leaves open-source families alone", () => {
    assert.equal(isPremiumFamily("deepseek/deepseek-v4-flash"), false)
    assert.equal(isPremiumFamily("qwen/qwen3-7-max"), false)
    assert.equal(isPremiumFamily("xiaomi/mimo-v2.5"), false)
  })

  it("deriveCatalogTier maps known premium sections to premium", () => {
    assert.deepStrictEqual(deriveCatalogTier("Anthropic", "anthropic/claude-sonnet-5"), {
      section: "Anthropic",
      tier: "premium",
    })
    assert.equal(deriveCatalogTier("OpenAI", "openai/gpt-5").tier, "premium")
    assert.equal(deriveCatalogTier("Google", "google/gemini-3-pro").tier, "premium")
  })

  it("deriveCatalogTier maps the Open Source section to open-source", () => {
    assert.deepStrictEqual(deriveCatalogTier("Open Source", "deepseek/deepseek-v4-flash"), {
      section: "Open Source",
      tier: "open-source",
    })
  })

  it("deriveCatalogTier treats unknown future sections as premium (safe default)", () => {
    assert.deepStrictEqual(deriveCatalogTier("Cohere", "cohere/command-r"), {
      section: "Cohere",
      tier: "premium",
    })
  })

  it("deriveCatalogTier without a section falls back to the family heuristic", () => {
    assert.equal(deriveCatalogTier(undefined, "gpt-5").tier, "premium")
    assert.equal(deriveCatalogTier(undefined, "deepseek/deepseek-v4-flash").tier, "open-source")
  })
})

describe("buildCmdCatalogRows section/tier propagation", () => {
  it("propagates section and derives tier while the Open Source filter still applies", () => {
    const rows = buildCmdCatalogRows([
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "fast model", section: "Open Source" },
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", description: "smart model", section: "Anthropic" },
    ], { filterSection: "Open Source" })

    assert.equal(rows.length, 1, "Open Source filter still applies")
    assert.equal(rows[0].id, "deepseek/deepseek-v4-flash")
    assert.equal(rows[0].section, "Open Source")
    assert.equal(rows[0].tier, "open-source")
  })

  it("without a filter every section keeps section+tier metadata", () => {
    const rows = buildCmdCatalogRows([
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", description: "smart model", section: "Anthropic" },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "fast model", section: "Open Source" },
    ])

    assert.equal(rows.length, 2)
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    assert.equal(byId["anthropic/claude-sonnet-5"].section, "Anthropic")
    assert.equal(byId["anthropic/claude-sonnet-5"].tier, "premium")
    assert.equal(byId["deepseek/deepseek-v4-flash"].section, "Open Source")
    assert.equal(byId["deepseek/deepseek-v4-flash"].tier, "open-source")
  })
})
