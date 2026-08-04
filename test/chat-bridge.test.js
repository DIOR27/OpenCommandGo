import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractRetryModelFromUnrecognizedError, startCommandCodeAlphaStream, UpstreamError } from "../src/runtime/chat-bridge.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("extractRetryModelFromUnrecognizedError", () => {
  const cases = [
    {
      name: "extracts providerless model from the exact upstream error",
      raw: "Model/provider not recognized: anthropic:minimaxai/minimax-m3",
      currentModel: "anthropic:minimaxai/minimax-m3",
      expected: "minimaxai/minimax-m3",
    },
    {
      name: "does not retry when the providerless model was already sent",
      raw: "Model/provider not recognized: anthropic:minimaxai/minimax-m3",
      currentModel: "minimaxai/minimax-m3",
      expected: null,
    },
    {
      name: "ignores other upstream errors",
      raw: "Model/provider unavailable: anthropic:minimaxai/minimax-m3",
      currentModel: "anthropic:minimaxai/minimax-m3",
      expected: null,
    },
    {
      name: "ignores malformed providerless variants",
      raw: "Model/provider not recognized: anthropic:",
      currentModel: "anthropic:model",
      expected: null,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.equal(
        extractRetryModelFromUnrecognizedError(testCase.raw, testCase.currentModel),
        testCase.expected,
      )
    })
  }
})

describe("startCommandCodeAlphaStream", () => {
  const settings = {
    commandCodeBaseUrl: "https://commandcode.test",
    commandCodeApiKey: "test-key",
    commandCodeVersion: "test-version",
  }
  const body = { model: "anthropic:source/model", messages: [{ role: "user", content: "hello" }], stream: true }

  it("retries once with the providerless model and preserves the session", async () => {
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, payload: JSON.parse(init.body) })
      return requests.length === 1
        ? new Response("Model/provider not recognized: anthropic:provider/model", { status: 403 })
        : new Response("data: [DONE]\n", { status: 200 })
    }

    const logs = []
    const result = await startCommandCodeAlphaStream(body, "anthropic:source/model", settings, {
      log: message => logs.push(message),
    })

    assert.equal(requests.length, 2)
    assert.equal(requests[0].payload.params.model, "anthropic:source/model")
    assert.equal(requests[1].payload.params.model, "provider/model")
    assert.equal(requests[0].init.headers["x-session-id"], requests[1].init.headers["x-session-id"])
    assert.ok(logs.some(message => message.includes("retry model=provider/model")))
    assert.ok(result.responseBody)
  })

  it("throws the second upstream error after one retry", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return calls === 1
        ? new Response("Model/provider not recognized: anthropic:provider/model", { status: 403 })
        : new Response("second failure", { status: 502 })
    }

    await assert.rejects(
      startCommandCodeAlphaStream(body, "anthropic:source/model", settings),
      error => error instanceof UpstreamError && error.status === 502 && error.message.includes("second failure"),
    )
    assert.equal(calls, 2)
  })

  it("does not duplicate a request when no material retry exists", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response("Model/provider not recognized: anthropic:provider/model", { status: 403 })
    }

    await assert.rejects(
      startCommandCodeAlphaStream(body, "provider/model", settings),
      error => error instanceof UpstreamError && error.status === 403,
    )
    assert.equal(calls, 1)
  })
})
