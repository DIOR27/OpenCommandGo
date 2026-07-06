import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectOpenCodeProvider, removeOpenCodeProvider, syncOpenCodeConfig } from "../src/opencode/config.js"
import { extractLatestSidecarUrl, normalizeResolvedProviders, resolveSidecarAuthCandidates } from "../src/opencode/sidecar-resolved-providers.js"

const ORIGINAL_ENV = {
  OCG_HOME: process.env.OCG_HOME,
  USERPROFILE: process.env.USERPROFILE,
  OPENCODE_SIDECAR_AUTHORIZATION: process.env.OPENCODE_SIDECAR_AUTHORIZATION,
}

afterEach(() => {
  restoreEnv("OCG_HOME", ORIGINAL_ENV.OCG_HOME)
  restoreEnv("USERPROFILE", ORIGINAL_ENV.USERPROFILE)
  restoreEnv("OPENCODE_SIDECAR_AUTHORIZATION", ORIGINAL_ENV.OPENCODE_SIDECAR_AUTHORIZATION)
})

describe("syncOpenCodeConfig", () => {
  it("registers commandcode automatically, keeps the legacy alias, and mirrors upstream model metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocg-opencode-config-"))
    const userProfile = join(root, "user")
    process.env.OCG_HOME = root
    process.env.USERPROFILE = userProfile

    try {
      const file = await syncOpenCodeConfig({
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

  it("removes both commandcode and ocg aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocg-opencode-remove-"))
    const userProfile = join(root, "user")
    process.env.OCG_HOME = root
    process.env.USERPROFILE = userProfile

    try {
      const file = await syncOpenCodeConfig({
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

  it("inherits video and reasoning from a matching configured provider", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
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

      await syncCommandCode({
        models: {
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
        },
      })

      const model = readProvider(file).models["MiniMaxAI/MiniMax-M3"]
      assert.deepStrictEqual(model.modalities.input, ["text", "video"])
      assert.equal(model.capabilities.video.supported, true)
      assert.equal(model.capabilities.video.source, "cross-provider-config:nvidia")
      assert.equal(model.reasoning, true)
    })
  })

  it("does not override an upstream false capability with cross-provider true", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
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

      await syncCommandCode({
        models: {
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
        },
      })

      const model = readProvider(file).models["MiniMaxAI/MiniMax-M3"]
      assert.equal(model.capabilities.video.supported, false)
      assert.equal(model.capabilities.video.source, "catalog.capabilities.video")
      assert.equal(model.reasoning, true)
    })
  })

  it("prefers the richest provider when matching capabilities conflict", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
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

      await syncCommandCode({
        models: {
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
        },
      })

      const model = readProvider(file).models["acme/doc-master"]
      assert.deepStrictEqual(model.modalities.input, ["text", "image", "pdf"])
      assert.equal(model.capabilities.pdf.supported, true)
      assert.equal(model.capabilities.pdf.source, "cross-provider-config:nvidia")
      assert.equal(model.capabilities.audio.supported, true)
      assert.equal(model.reasoning, true)
    })
  })

  it("leaves commandcode models unchanged when no other providers are configured", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root)

      await syncCommandCode({
        models: {
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
        },
      })

      const model = readProvider(file).models["acme/plain-text-only"]
      assert.deepStrictEqual(model.modalities.input, ["text"])
      assert.equal(model.capabilities.video.supported, null)
      assert.equal(model.reasoning, undefined)
    })
  })

  it("matches providerless ids and transfers vision support", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
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

      await syncCommandCode({
        models: {
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
        },
      })

      const model = readProvider(file).models["Llama-3.1-8B-Instruct"]
      assert.deepStrictEqual(model.modalities.input, ["text", "image"])
      assert.equal(model.capabilities.vision.supported, true)
      assert.equal(model.capabilities.vision.source, "cross-provider-config:nvidia")
    })
  })

  it("prefers sidecar-resolved metadata over file-config metadata when both match", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
        provider: {
          openrouter: {
            models: {
              "acme/omni": {
                modalities: { input: ["text", "pdf"], output: ["text"] },
                capabilities: {
                  pdf: { supported: true, source: "config.pdf" },
                },
                limit: { context: 64000 },
              },
            },
          },
        },
      })

      await syncCommandCode({
        models: {
          "acme/omni": {
            name: "Omni",
            status: "ok",
            context_length: null,
            capabilities: {
              vision: { supported: null, source: null },
              pdf: { supported: null, source: null },
              audio: { supported: null, source: null },
              video: { supported: null, source: null },
            },
          },
        },
        resolvedProviderMetadata: {
          openrouter: {
            models: {
              "acme/omni": {
                modalities: { input: ["text", "pdf", "audio"], output: ["text"] },
                capabilities: {
                  pdf: { supported: true, source: "sidecar.pdf" },
                  audio: { supported: true, source: "sidecar.audio" },
                },
                limit: { context: 128000 },
              },
            },
          },
        },
      })

      const model = readProvider(file).models["acme/omni"]
      assert.deepStrictEqual(model.modalities.input, ["text", "pdf", "audio"])
      assert.equal(model.capabilities.pdf.source, "cross-provider-sidecar:openrouter")
      assert.equal(model.capabilities.audio.source, "cross-provider-sidecar:openrouter")
      assert.equal(model.limit.context, 200000)
    })
  })

  it("gracefully falls back to file-config metadata when sidecar auth fails", async () => {
    await withOpenCodeFixture(async root => {
      const file = await seedExistingConfig(root, {
        provider: {
          hyperbolic: {
            models: {
              "vendor/media-pro": {
                modalities: { input: ["text", "video"], output: ["text"] },
                capabilities: {
                  video: { supported: true, source: "config.video" },
                },
              },
            },
          },
        },
      })

      await syncCommandCode({
        models: {
          "vendor/media-pro": {
            name: "Media Pro",
            status: "ok",
            capabilities: {
              vision: { supported: null, source: null },
              pdf: { supported: null, source: null },
              audio: { supported: null, source: null },
              video: { supported: null, source: null },
            },
          },
        },
        readResolvedProviders: async () => ({ ok: false, code: "unauthorized", providers: {} }),
      })

      const model = readProvider(file).models["vendor/media-pro"]
      assert.equal(model.capabilities.video.supported, true)
      assert.equal(model.capabilities.video.source, "cross-provider-config:hyperbolic")
    })
  })

  it("does not overwrite explicit commandcode values with sidecar metadata", async () => {
    await withOpenCodeFixture(async () => {
      const file = await seedExistingConfig()

      await syncCommandCode({
        models: {
          "vendor/deep-thinker": {
            name: "Deep Thinker",
            status: "ok",
            context_length: 4096,
            tags: [],
            capabilities: {
              vision: { supported: true, source: "catalog.capabilities.vision" },
              pdf: { supported: null, source: null },
              audio: { supported: null, source: null },
              video: { supported: false, source: "catalog.capabilities.video" },
            },
          },
        },
        resolvedProviderMetadata: {
          together: {
            models: {
              "vendor/deep-thinker": {
                modalities: { input: ["text", "image", "video"], output: ["text"] },
                capabilities: {
                  vision: { supported: true, source: "sidecar.vision" },
                  video: { supported: true, source: "sidecar.video" },
                },
                reasoning: true,
                limit: { context: 999999 },
              },
            },
          },
        },
      })

      const model = readProvider(file).models["vendor/deep-thinker"]
      assert.equal(model.capabilities.video.supported, false)
      assert.equal(model.capabilities.video.source, "catalog.capabilities.video")
      assert.equal(model.capabilities.vision.source, "catalog.capabilities.vision")
      assert.equal(model.limit.context, 4096)
      assert.deepStrictEqual(model.modalities.input, ["text", "image"])
    })
  })
})

describe("sidecar resolved provider helpers", () => {
  it("extracts the latest sidecar url from desktop logs", () => {
    assert.equal(
      extractLatestSidecarUrl("before\nserver ready { url: 'http://127.0.0.1:33333' }\nafter\nserver ready { url: 'http://127.0.0.1:44444' }"),
      "http://127.0.0.1:44444",
    )
  })

  it("normalizes resolved provider payloads generically", () => {
    const providers = normalizeResolvedProviders({
      providers: [
        {
          providerID: "openrouter",
          models: [
            {
              modelId: "meta-llama/llama-4-maverick",
              modalities: { input: ["text", "image"], output: ["text"] },
              capabilities: { vision: { supported: true, source: "runtime" } },
              contextWindow: 12345,
              reasoning: true,
            },
          ],
        },
      ],
    })

    assert.equal(providers.openrouter.models["meta-llama/llama-4-maverick"].limit.context, 12345)
    assert.equal(providers.openrouter.models["meta-llama/llama-4-maverick"].capabilities.vision.supported, true)
    assert.equal(providers.openrouter.models["meta-llama/llama-4-maverick"].reasoning, true)
  })

  it("builds auth candidates from env overrides plus anonymous fallback", () => {
    process.env.OPENCODE_SIDECAR_AUTHORIZATION = "Basic abc123"
    assert.deepStrictEqual(resolveSidecarAuthCandidates(), [
      { kind: "authorization", authorization: "Basic abc123" },
      { kind: "none" },
    ])
  })
})

async function withOpenCodeFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "ocg-opencode-config-"))
  const userProfile = join(root, "user")
  process.env.OCG_HOME = root
  process.env.USERPROFILE = userProfile
  try {
    await callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function seedExistingConfig(_root, partial = {}) {
  const file = await syncOpenCodeConfig({
    host: "127.0.0.1",
    port: 4310,
    createIfMissing: true,
    providers: [],
    readResolvedProviders: async () => ({ ok: false, code: "test-noop", providers: {} }),
  })
  const base = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...base, ...partial }, null, 2), "utf8")
  return file
}

async function syncCommandCode({ models, resolvedProviderMetadata, readResolvedProviders } = {}) {
  await syncOpenCodeConfig({
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
    ...(resolvedProviderMetadata ? { resolvedProviderMetadata } : {}),
    readResolvedProviders: readResolvedProviders || (async () => ({ ok: false, code: "test-noop", providers: {} })),
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
