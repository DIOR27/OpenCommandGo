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
})

function restoreEnv(key, value) {
  if (typeof value === "string") {
    process.env[key] = value
    return
  }
  delete process.env[key]
}
