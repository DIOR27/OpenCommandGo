import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { comparableCommandCodeModel, resolveBridgeInputModalities, resolveFallbackModelHints } from "../src/shared/models.js"
import { toCommandCodeMessages } from "../src/runtime/chat-bridge.js"
import { buildCatalogOnlyCompatibilityEntry, createCatalogController } from "../src/runtime/catalog-runtime.js"
import { buildCmdCatalogRows } from "../src/shared/commandcode-cmd-catalog.js"

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
