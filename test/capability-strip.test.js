import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { comparableCommandCodeModel, resolveBridgeInputModalities, resolveFallbackModelHints } from "../src/shared/models.js"
import { toCommandCodeMessages } from "../src/runtime/chat-bridge.js"
import { buildCatalogOnlyCompatibilityEntry } from "../src/runtime/catalog-runtime.js"

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
