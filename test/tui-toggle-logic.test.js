import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { nextCapOverride, resolveCapActual } from "../src/cli/main.js"

describe("capability toggle 2-state logic (T9)", () => {
  it("resolveCapActual: override wins, else catalog value, else null", () => {
    const caps = { vision: { supported: true } }
    assert.equal(resolveCapActual({}, caps, "vision"), true, "catalog value used when no override")
    assert.equal(resolveCapActual({ vision: false }, caps, "vision"), false, "explicit override wins")
    assert.equal(resolveCapActual({ vision: true }, {}, "vision"), true)
    assert.equal(resolveCapActual({}, {}, "audio"), null, "nothing known -> null")
  })

  it("nextCapOverride: no override sets the opposite of actual", () => {
    assert.equal(nextCapOverride(true, undefined), false)
    assert.equal(nextCapOverride(false, undefined), true)
    assert.equal(nextCapOverride(null, undefined), true, "unknown capability defaults to enabling")
  })

  it("nextCapOverride: an existing override clears back to null (2-state, no tri-state flip)", () => {
    assert.equal(nextCapOverride(false, false), null)
    assert.equal(nextCapOverride(true, true), null)
  })
})
