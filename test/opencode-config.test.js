import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectOpenCodeProvider, removeOpenCodeProvider, syncOpenCodeConfig } from "../src/opencode/config.js"

const ORIGINAL_ENV = {
  OCG_HOME: process.env.OCG_HOME,
  USERPROFILE: process.env.USERPROFILE,
}

afterEach(() => {
  restoreEnv("OCG_HOME", ORIGINAL_ENV.OCG_HOME)
  restoreEnv("USERPROFILE", ORIGINAL_ENV.USERPROFILE)
})

describe("syncOpenCodeConfig", () => {
  it("registers commandcode automatically, keeps the legacy alias, and mirrors upstream model metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "ocg-opencode-config-"))
    const userProfile = join(root, "user")
    process.env.OCG_HOME = root
    process.env.USERPROFILE = userProfile

    try {
      const file = syncOpenCodeConfig({
        host: "127.0.0.1",
        port: 4310,
        createIfMissing: true,
        providers: [
          {
            id: "commandcode",
            kind: "commandcode",
            routePrefix: "commandcode",
            name: "Command Code",
            compatibilityMatrix: {
              models: {
                "xiaomi/MiMo-V2.5": {
                  name: "MiMo V2.5",
                  status: "ok",
                  tags: ["reasoning"],
                  capabilities: {
                    vision: { supported: true, source: "catalog.capabilities.vision" },
                    pdf: { supported: true, source: "catalog.capabilities.pdf" },
                    audio: { supported: true, source: "catalog.capabilities.audio" },
                    video: { supported: true, source: "catalog.capabilities.video" },
                  },
                },
              },
            },
          },
        ],
      })

      const config = JSON.parse(readFileSync(file, "utf8"))
      const provider = config.provider.commandcode
      assert.ok(provider)
      assert.ok(config.provider.ocg)
      assert.equal(provider.name, "Command Code")
      assert.equal(provider.options.baseURL, "http://127.0.0.1:4310/commandcode/v1")
      assert.deepStrictEqual(provider.models["xiaomi/MiMo-V2.5"].modalities.input, ["text", "image", "pdf", "audio", "video"])
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].capabilities.vision.supported, true)
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].capabilities.pdf.supported, true)
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].capabilities.audio.supported, true)
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].capabilities.video.supported, true)
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].capabilities.video.source, "catalog.capabilities.video")
      assert.equal(provider.models["xiaomi/MiMo-V2.5"].reasoning, true)
      assert.deepStrictEqual(inspectOpenCodeProvider("ocg"), provider)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("removes both commandcode and ocg aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "ocg-opencode-remove-"))
    const userProfile = join(root, "user")
    process.env.OCG_HOME = root
    process.env.USERPROFILE = userProfile

    try {
      const file = syncOpenCodeConfig({
        host: "127.0.0.1",
        port: 4310,
        createIfMissing: true,
        providers: [
          {
            id: "commandcode",
            kind: "commandcode",
            routePrefix: "commandcode",
            name: "Command Code",
            compatibilityMatrix: { models: {} },
          },
        ],
      })

      const config = JSON.parse(readFileSync(file, "utf8"))
      config.model = "ocg/moonshotai/Kimi-K2.5"
      config.provider.ocg = config.provider.commandcode
      writeFileSync(file, JSON.stringify(config, null, 2), "utf8")

      assert.equal(removeOpenCodeProvider("commandcode"), true)
      const next = JSON.parse(readFileSync(file, "utf8"))
      assert.equal(next.provider?.commandcode, undefined)
      assert.equal(next.provider?.ocg, undefined)
      assert.equal(next.model, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("inherits video and reasoning from a matching configured provider", () => {
    withOpenCodeFixture(root => {
      const file = seedExistingConfig(root, {
        provider: {
          nvidia: {
            models: {
              "minimaxai/minimax-m3": {
                modalities: { input: ["text", "video"], output: ["text"] },
                capabilities: {
                  video: { supported: true, source: "catalog.capabilities.video" },
                },
                reasoning: true,
                limit: { context: 123456 },
              },
            },
          },
        },
      })

      syncCommandCode(file, {
        "MiniMaxAI/MiniMax-M3": {
          name: "MiniMax M3",
          status: "ok",
          capabilities: {
            vision: { supported: null, source: null },
            pdf: { supported: null, source: null },
            audio: { supported: null, source: null },
            video: { supported: null, source: null },
          },
          context_length: null,
        },
      })

      const model = readProvider(file).models["MiniMaxAI/MiniMax-M3"]
      assert.deepStrictEqual(model.modalities.input, ["text", "video"])
      assert.equal(model.capabilities.video.supported, true)
      assert.equal(model.capabilities.video.source, "cross-provider:nvidia")
      assert.equal(model.reasoning, true)
    })
  })

  it("does not override an upstream false capability with cross-provider true", () => {
    withOpenCodeFixture(root => {
      const file = seedExistingConfig(root, {
        provider: {
          nvidia: {
            models: {
              "minimaxai/minimax-m3": {
                modalities: { input: ["text", "video"], output: ["text"] },
                capabilities: {
                  video: { supported: true, source: "catalog.capabilities.video" },
                },
                reasoning: true,
              },
            },
          },
        },
      })

      syncCommandCode(file, {
        "MiniMaxAI/MiniMax-M3": {
          name: "MiniMax M3",
          status: "ok",
          capabilities: {
            vision: { supported: null, source: null },
            pdf: { supported: null, source: null },
            audio: { supported: null, source: null },
            video: { supported: false, source: "catalog.capabilities.video" },
          },
        },
      })

      const model = readProvider(file).models["MiniMaxAI/MiniMax-M3"]
      assert.equal(model.capabilities.video.supported, false)
      assert.equal(model.capabilities.video.source, "catalog.capabilities.video")
      assert.equal(model.reasoning, true)
    })
  })

  it("prefers the richest provider when matching capabilities conflict", () => {
    withOpenCodeFixture(root => {
      const file = seedExistingConfig(root, {
        provider: {
          groq: {
            models: {
              "acme/doc-master": {
                modalities: { input: ["text", "pdf"], output: ["text"] },
                capabilities: {
                  pdf: { supported: false, source: "groq.pdf" },
                },
              },
            },
          },
          nvidia: {
            models: {
              "acme/doc-master": {
                modalities: { input: ["text", "pdf", "image"], output: ["text"] },
                capabilities: {
                  vision: { supported: true, source: "nvidia.vision" },
                  pdf: { supported: true, source: "nvidia.pdf" },
                  audio: { supported: true, source: "nvidia.audio" },
                },
                reasoning: true,
              },
            },
          },
        },
      })

      syncCommandCode(file, {
        "acme/doc-master": {
          name: "Doc Master",
          status: "ok",
          capabilities: {
            vision: { supported: null, source: null },
            pdf: { supported: null, source: null },
            audio: { supported: null, source: null },
            video: { supported: null, source: null },
          },
        },
      })

      const model = readProvider(file).models["acme/doc-master"]
      assert.deepStrictEqual(model.modalities.input, ["text", "image", "pdf"])
      assert.equal(model.capabilities.pdf.supported, true)
      assert.equal(model.capabilities.pdf.source, "cross-provider:nvidia")
      assert.equal(model.capabilities.audio.supported, true)
      assert.equal(model.reasoning, true)
    })
  })

  it("leaves commandcode models unchanged when no other providers are configured", () => {
    withOpenCodeFixture(root => {
      const file = seedExistingConfig(root)

      syncCommandCode(file, {
        "acme/plain-text-only": {
          name: "Plain Text Only",
          status: "ok",
          capabilities: {
            vision: { supported: null, source: null },
            pdf: { supported: null, source: null },
            audio: { supported: null, source: null },
            video: { supported: null, source: null },
          },
        },
      })

      const model = readProvider(file).models["acme/plain-text-only"]
      assert.deepStrictEqual(model.modalities.input, ["text"])
      assert.equal(model.capabilities.video.supported, null)
      assert.equal(model.reasoning, undefined)
    })
  })

  it("matches providerless ids and transfers vision support", () => {
    withOpenCodeFixture(root => {
      const file = seedExistingConfig(root, {
        provider: {
          nvidia: {
            models: {
              "nvidia/Llama-3.1-8B-Instruct": {
                modalities: { input: ["text", "image"], output: ["text"] },
                capabilities: {
                  vision: { supported: true, source: "catalog.capabilities.vision" },
                },
              },
            },
          },
        },
      })

      syncCommandCode(file, {
        "Llama-3.1-8B-Instruct": {
          name: "Llama 3.1 8B Instruct",
          status: "ok",
          capabilities: {
            vision: { supported: null, source: null },
            pdf: { supported: null, source: null },
            audio: { supported: null, source: null },
            video: { supported: null, source: null },
          },
        },
      })

      const model = readProvider(file).models["Llama-3.1-8B-Instruct"]
      assert.deepStrictEqual(model.modalities.input, ["text", "image"])
      assert.equal(model.capabilities.vision.supported, true)
      assert.equal(model.capabilities.vision.source, "cross-provider:nvidia")
    })
  })
})

function withOpenCodeFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "ocg-opencode-config-"))
  const userProfile = join(root, "user")
  process.env.OCG_HOME = root
  process.env.USERPROFILE = userProfile
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function seedExistingConfig(root, partial = {}) {
  const file = syncOpenCodeConfig({
    host: "127.0.0.1",
    port: 4310,
    createIfMissing: true,
    providers: [],
  })
  const base = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...base, ...partial }, null, 2), "utf8")
  return file
}

function syncCommandCode(_file, models) {
  syncOpenCodeConfig({
    host: "127.0.0.1",
    port: 4310,
    createIfMissing: true,
    providers: [
      {
        id: "commandcode",
        kind: "commandcode",
        routePrefix: "commandcode",
        name: "Command Code",
        compatibilityMatrix: { models },
      },
    ],
  })
}

function readProvider(file) {
  return JSON.parse(readFileSync(file, "utf8")).provider.commandcode
}

function restoreEnv(key, value) {
  if (typeof value === "string") {
    process.env[key] = value
    return
  }
  delete process.env[key]
}
