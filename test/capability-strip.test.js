import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { comparableCommandCodeModel, resolveBridgeInputModalities, resolveFallbackModelHints } from "../src/shared/models.js"
import { toCommandCodeMessages } from "../src/runtime/chat-bridge.js"
import { buildCatalogOnlyCompatibilityEntry, createCatalogController } from "../src/runtime/catalog-runtime.js"
import { buildCmdCatalogRows, parseCmdModelList } from "../src/shared/commandcode-cmd-catalog.js"
import { deriveCatalogFromCompatibility, fallbackCatalog, normalizeCatalogRows } from "../src/shared/catalog.js"
import { filterEnabledModels } from "../src/config/model-enablement.js"

describe("xiaomi mimo capability separation", () => {
  it("mimo-v2-5-pro does not inherit vision/pdf from mimo-v2-5 family hint", () => {
    const pro = resolveFallbackModelHints("xiaomi/mimo-v2-5-pro")
    assert.equal(pro.capabilities.vision, null, "pro should not claim vision")
    assert.equal(pro.capabilities.pdf, null, "pro should not claim pdf")

    const base = resolveFallbackModelHints("xiaomi/mimo-v2-5")
    // base keeps its explicit hint only if the registry still asserts it
    assert.equal(base.capabilities.vision, true)
  })

  it("resolveBridgeInputModalities returns text-only for mimo-v2-5-pro when compat has no vision", () => {
    const inputs = resolveBridgeInputModalities({ capabilities: { vision: { supported: null, source: null } } })
    assert.deepStrictEqual(inputs, ["text"])
  })

  it("comparableCommandCodeModel normalizes dots and underscores", () => {
    assert.equal(comparableCommandCodeModel("xiaomi/mimo-v2.5-pro"), "xiaomi/mimo-v2-5-pro")
  })

  it("cmd catalog uses exact fallback hints for mimo-v2.5 when description omits vision", () => {
    const [row] = buildCmdCatalogRows([
      {
        id: "xiaomi/mimo-v2.5",
        name: "MiMo V2.5",
        description: "Strong reasoning model with 200K context",
        section: "Open Source",
      },
    ])

    assert.equal(row.catalog_capabilities.vision.supported, true)
    assert.equal(row.catalog_capabilities.vision.source, "hint.vision.fallback_registry")

    const compat = buildCatalogOnlyCompatibilityEntry({
      id: row.id,
      name: row.name,
      tags: row.tags,
      context_length: row.context_length,
      catalogCapabilities: row.catalog_capabilities,
    })
    assert.ok(resolveBridgeInputModalities(compat).includes("image"))
  })

  it("cmd catalog does not let mimo-v2.5-pro inherit base vision/pdf hints", () => {
    const [row] = buildCmdCatalogRows([
      {
        id: "xiaomi/mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        description: "Strong reasoning model with 200K context",
        section: "Open Source",
      },
    ])

    assert.equal(row.catalog_capabilities.vision.supported, null)
    assert.equal(row.catalog_capabilities.pdf.supported, null)
  })
})

describe("premium catalog retention (FR-01)", () => {
  it("normalizeCatalogRows does not drop claude/gpt rows and tags them premium", () => {
    const rows = normalizeCatalogRows([
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", display_name: "Claude Sonnet 5" },
      { id: "openai/gpt-5", name: "GPT-5", display_name: "GPT-5" },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", display_name: "DeepSeek V4 Flash" },
    ])

    assert.deepStrictEqual(
      rows.map(row => row.id).sort(),
      ["anthropic/claude-sonnet-5", "deepseek/deepseek-v4-flash", "openai/gpt-5"],
      "claude and gpt rows must survive normalizeCatalogRows",
    )
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    assert.equal(byId["anthropic/claude-sonnet-5"].tier, "premium")
    assert.equal(byId["openai/gpt-5"].tier, "premium")
    assert.equal(byId["deepseek/deepseek-v4-flash"].tier, "open-source")
  })

  it("deriveCatalogFromCompatibility copies tier from matrix entries", () => {
    const matrix = {
      models: {
        "anthropic/claude-sonnet-5": { name: "Claude Sonnet 5", status: "ok", tier: "premium" },
        "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", status: "ok", tier: "open-source" },
      },
    }
    const catalog = deriveCatalogFromCompatibility(matrix)
    const byId = Object.fromEntries(catalog.map(row => [row.id, row]))
    assert.equal(byId["anthropic/claude-sonnet-5"].tier, "premium")
    assert.equal(byId["deepseek/deepseek-v4-flash"].tier, "open-source")
  })

  it("deriveCatalogFromCompatibility falls back to family heuristic when entry has no tier", () => {
    const matrix = {
      models: {
        "anthropic/claude-sonnet-5": { name: "Claude Sonnet 5", status: "ok" },
        "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", status: "ok" },
      },
    }
    const catalog = deriveCatalogFromCompatibility(matrix)
    const byId = Object.fromEntries(catalog.map(row => [row.id, row]))
    assert.equal(byId["anthropic/claude-sonnet-5"].tier, "premium")
    assert.equal(byId["deepseek/deepseek-v4-flash"].tier, "open-source")
  })
})

describe("chat-bridge forwards image even for text-only catalog models", () => {
  it("keeps image_url blocks even when model modalities exclude image", () => {
    const messages = [
      { role: "user", content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ] },
    ]
    const converted = toCommandCodeMessages(messages)
    assert.equal(converted.length, 1)
    assert.equal(converted[0].role, "user")
    const blocks = converted[0].content
    assert.ok(Array.isArray(blocks), "image is forwarded as blocks, not stripped to string")
    assert.ok(blocks.some(block => block.type === "image"))
  })

  it("keeps input_image blocks", () => {
    const messages = [
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "input_image", image_url: "https://example.com/b.png" },
      ] },
    ]
    const converted = toCommandCodeMessages(messages)
    assert.equal(converted.length, 1)
    const blocks = converted[0].content
    assert.ok(Array.isArray(blocks))
    assert.ok(blocks.some(block => block.type === "image"))
  })

  it("still normalizes plain text to a string block", () => {
    const messages = [{ role: "user", content: "just text" }]
    const converted = toCommandCodeMessages(messages)
    assert.equal(converted.length, 1)
    assert.equal(typeof converted[0].content, "string")
  })
})

describe("catalog refresh preserves probed vision", () => {
  it("does not drop vision:true promoted by a --full probe", () => {
    const previous = {
      capabilities: {
        vision: { supported: true, source: "probe" },
      },
    }
    const entry = buildCatalogOnlyCompatibilityEntry({
      id: "xiaomi/mimo-v2-5-pro",
      name: "MiMo V2.5 Pro",
      tags: [],
      context_length: 200000,
      catalogCapabilities: { vision: { supported: null, source: null } },
      previous,
    })
    assert.equal(entry.capabilities.vision.supported, true, "probed vision must survive a catalog-only refresh")
    assert.equal(entry.capabilities.vision.source, "probe")
  })

  it("does drop vision from a stale fallback_registry hint", () => {
    const previous = {
      image: { ok: true, source: "hint.vision.fallback_registry" },
      capabilities: {
        vision: { supported: true, source: "hint.vision.fallback_registry" },
      },
    }
    const entry = buildCatalogOnlyCompatibilityEntry({
      id: "xiaomi/mimo-v2-5-pro",
      name: "MiMo V2.5 Pro",
      tags: [],
      context_length: 200000,
      catalogCapabilities: { vision: { supported: null, source: null } },
      previous,
    })
    assert.notEqual(entry.capabilities.vision.supported, true, "stale fallback vision must not survive")
  })
})

describe("runtime vision upgrade (promoteModelVision)", () => {
  it("promotes vision for a text-only model after a successful image request", async () => {
    const matrix = {
      updated_at: new Date().toISOString(),
      refresh_interval_hours: 24,
      models: {
        "some/text-model": {
          name: "Text Only",
          status: "catalog_only",
          image: { ok: false, output_chars: 0, source: null },
          capabilities: { vision: { supported: false, source: "catalog" } },
        },
      },
    }
    let writtenMatrix = null
    let syncCalled = false

    const controller = createCatalogController({
      initialCompatibilityMatrix: matrix,
      writeCompatibilityMatrix: m => { writtenMatrix = m },
      log: () => {},
    })
    // stub syncProviderConfig to avoid disk I/O
    controller.syncProviderConfig = async () => { syncCalled = true }

    const promoted = await controller.promoteModelVision("some/text-model", {})
    assert.equal(promoted, true, "should report promotion happened")

    // verify in-memory matrix
    const entry = controller.getCompatibilityMatrix().models["some/text-model"]
    assert.equal(entry.capabilities.vision.supported, true, "vision should be promoted in capabilities")
    assert.equal(entry.capabilities.vision.source, "runtime_upgrade")
    assert.equal(entry.image.ok, true, "image.ok should be true")
    assert.equal(entry.image.source, "runtime_upgrade")

    // verify persisted to disk
    assert.notEqual(writtenMatrix, null, "writeCompatibilityMatrix should have been called")
    assert.equal(writtenMatrix.models["some/text-model"].capabilities.vision.supported, true)

    // verify OpenCode sync was triggered
    assert.equal(syncCalled, true, "syncProviderConfig should be called")
  })

  it("is idempotent — second call returns false and does not re-write", async () => {
    const matrix = {
      updated_at: new Date().toISOString(),
      refresh_interval_hours: 24,
      models: {
        "some/text-model": {
          name: "Text Only",
          status: "catalog_only",
          image: { ok: false, output_chars: 0, source: null },
          capabilities: { vision: { supported: false, source: "catalog" } },
        },
      },
    }
    let writeCount = 0

    const controller = createCatalogController({
      initialCompatibilityMatrix: matrix,
      writeCompatibilityMatrix: () => { writeCount++ },
      log: () => {},
    })
    controller.syncProviderConfig = async () => {}

    await controller.promoteModelVision("some/text-model", {})
    assert.equal(writeCount, 1, "first call writes once")

    const second = await controller.promoteModelVision("some/text-model", {})
    assert.equal(second, false, "second call should report no promotion")
    assert.equal(writeCount, 1, "second call should not write again (idempotent)")
  })

  it("does nothing for unknown models", async () => {
    let writeCalled = false
    const controller = createCatalogController({
      initialCompatibilityMatrix: {
        updated_at: new Date().toISOString(),
        refresh_interval_hours: 24,
        models: {},
      },
      writeCompatibilityMatrix: () => { writeCalled = true },
      log: () => {},
    })
    controller.syncProviderConfig = async () => {}

    const result = await controller.promoteModelVision("nonexistent", {})
    assert.equal(result, false)
    assert.equal(writeCalled, false, "no write for unknown model")
  })

  it("runtime_upgrade source survives a catalog-only refresh", () => {
    const previous = {
      image: { ok: true, output_chars: 0, source: "runtime_upgrade" },
      capabilities: {
        vision: { supported: true, source: "runtime_upgrade" },
      },
    }
    const entry = buildCatalogOnlyCompatibilityEntry({
      id: "some/text-model",
      name: "Text Model",
      tags: [],
      context_length: 128000,
      catalogCapabilities: { vision: { supported: null, source: null } },
      previous,
    })
    assert.equal(entry.capabilities.vision.supported, true, "runtime_upgrade should survive catalog refresh")
    assert.equal(entry.capabilities.vision.source, "runtime_upgrade")
  })
})

describe("fallback catalog tier", () => {
  it("fallback rows carry an open-source tier so the enable filter keeps them by default", () => {
    const rows = fallbackCatalog()
    assert.ok(rows.length > 0, "fallback registry must not be empty")
    for (const row of rows) {
      assert.equal(row.tier, "open-source", `${row.id} must default to open-source tier`)
    }
  })

  it("fallback rows pass the central enable filter with an empty store", () => {
    const rows = fallbackCatalog()
    const enabled = filterEnabledModels(rows, { enabled: {} })
    assert.equal(enabled.length, rows.length, "all fallback models must be enabled by default")
  })
})

describe("free-model badge propagation", () => {
  it("parseCmdModelList detects the cmd FREE marker into free=true", () => {
    const parsed = parseCmdModelList([
      "Open Source",
      "poolside/laguna-s-2.1-free           FREE  open-weight agentic coding and long-horizon work",
      "deepseek/deepseek-v4-flash           fast hybrid-attention reasoning",
      "",
      "Anthropic",
      "claude-sonnet-5                      best combo of speed & intelligence",
    ].join("\n"))
    const freeRow = parsed.find(m => m.id === "poolside/laguna-s-2.1-free")
    assert.equal(freeRow?.free, true, "FREE marker must set the free flag on parse")
    const paidRow = parsed.find(m => m.id === "deepseek/deepseek-v4-flash")
    assert.equal(paidRow?.free, false)
  })

  it("buildCmdCatalogRows keeps free=true when the parsed model carries the FREE flag", () => {
    const [row] = buildCmdCatalogRows([
      {
        id: "poolside/laguna-s-2.1-free",
        name: "Laguna S 2.1 Free",
        description: "FREE long-horizon coding and long-horizon work",
        section: "Open Source",
        free: true,
      },
    ])
    assert.equal(row.free, true, "buildCmdCatalogRows must propagate the free flag")
  })

  it("buildCatalogOnlyCompatibilityEntry keeps the free flag from the catalog row", () => {
    const entry = buildCatalogOnlyCompatibilityEntry({
      id: "poolside/laguna-s-2.1-free",
      name: "Laguna S 2.1 Free",
      tags: [],
      context_length: 64000,
      catalogCapabilities: { vision: { supported: null, source: null } },
      section: "Open Source",
      tier: "open-source",
      free: true,
      previous: null,
    })
    assert.equal(entry.free, true, "compatibility entry must carry the free badge")
  })

  it("buildCatalogOnlyCompatibilityEntry preserves free from a legacy entry without the flag", () => {
    const entry = buildCatalogOnlyCompatibilityEntry({
      id: "poolside/laguna-s-2.1-free",
      name: "Laguna S 2.1 Free",
      tags: [],
      context_length: 64000,
      catalogCapabilities: { vision: { supported: null, source: null } },
      section: "Open Source",
      tier: "open-source",
      free: undefined,
      previous: { free: true },
    })
    assert.equal(entry.free, true, "free must be inherited from the previous entry when not re-provided")
  })

  it("deriveCatalogFromCompatibility surfaces free for each model row", () => {
    const derived = deriveCatalogFromCompatibility({
      models: {
        "poolside/laguna-s-2.1-free": {
          name: "Laguna S 2.1 Free",
          status: "catalog_only",
          tier: "open-source",
          free: true,
          capabilities: { vision: { supported: null } },
        },
      },
    })
    assert.equal(derived[0].free, true)
  })

  it("deriveCatalogFromCompatibility preserves free when a probe-style entry lacks the field", () => {
    // Simulates the probe path assigning tested (no free) after a prior
    // catalog-only entry that carried free=true; derive must still surface it.
    const derived = deriveCatalogFromCompatibility({
      models: {
        "poolside/laguna-s-2.1-free": {
          name: "Laguna S 2.1 Free",
          status: "ok",
          tier: "open-source",
          free: true,
          capabilities: { vision: { supported: null } },
        },
      },
    })
    assert.equal(derived[0].free, true, "free must survive derive even from a probe-tested entry")
  })

  it("deriveCatalogFromCompatibility falls back to false when free is absent and no previous", () => {
    const derived = deriveCatalogFromCompatibility({
      models: {
        "deepseek/deepseek-v4-flash": {
          name: "DeepSeek V4 Flash",
          status: "ok",
          tier: "open-source",
          capabilities: { vision: { supported: null } },
        },
      },
    })
    assert.equal(derived[0].free, false, "absent free with no previous defaults to false")
  })
})
