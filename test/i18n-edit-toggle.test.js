import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { messages } from "../src/shared/i18n.js"

describe("edit toggle i18n keys (FR-03)", () => {
  const REQUIRED = ["edit.enabled", "edit.disabled", "edit.hint", "error.premium_model"]

  it("defines the toggle keys in both en and es", () => {
    for (const key of REQUIRED) {
      assert.equal(typeof messages.en[key], "string", `en ${key} missing`)
      assert.equal(typeof messages.es[key], "string", `es ${key} missing`)
      assert.ok(messages.en[key].length > 0, `en ${key} empty`)
      assert.ok(messages.es[key].length > 0, `es ${key} empty`)
    }
  })

  it("edit.enabled and edit.disabled are single-word statuses the colorizer knows", () => {
    assert.match(messages.en["edit.enabled"], /^(enabled|ENABLED)$/)
    assert.match(messages.en["edit.disabled"], /^(disabled|DISABLED)$/)
  })

  it("edit.hint mentions the e key and enable/disable", () => {
    assert.match(messages.en["edit.hint"], /e/i)
    assert.match(messages.en["edit.hint"], /enable/i)
    assert.match(messages.en["edit.hint"], /disable/i)
    assert.match(messages.es["edit.hint"], /e/i)
    assert.match(messages.es["edit.hint"], /habilit/i)
    assert.match(messages.es["edit.hint"], /deshabilit/i)
  })

  it("error.premium_model keeps the error.type contract used by the server", () => {
    assert.match(messages.en["error.premium_model"], /premium/i)
    assert.match(messages.es["error.premium_model"], /premium/i)
  })
})
