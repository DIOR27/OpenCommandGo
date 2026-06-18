import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtempSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoDir = join(__dirname, "..")
const cliEntry = join(repoDir, "bin", "ocg.js")
const cleanupTasks = []

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop()
    try {
      await task()
    } catch {
      // ignore cleanup failures in tests
    }
  }
})

describe("ocg CLI integration", () => {
  it("starts in background, syncs OpenCode config, and avoids duplicate start", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)
    seedOpenCodeConfig(ctx.paths.opencodeConfigFile)

    const first = await runCli(["start", "--background"], ctx.env)
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /OpenCommandGo launched|OpenCommandGo lanzado/i)
    assert.match(first.stdout, /Watchdog/i)

    const secrets = readJson(ctx.paths.secretsFile)
    assert.ok(secrets?.shimAccessToken, "missing shim token")

    const health = await waitForHealth(ctx.port, secrets.shimAccessToken)
    assert.equal(health?.ok, true)
    assert.equal(health?.provider, "ocg")

    const opencodeConfig = readJson(ctx.paths.opencodeConfigFile)
    const provider = opencodeConfig?.provider?.cmdshim
    assert.ok(provider, "expected provider to be synced into OpenCode config")
    assert.equal(provider.name, "OCG CommandCode")
    assert.equal(provider.options?.baseURL, `http://127.0.0.1:${ctx.port}/v1`)
    assert.equal(provider.options?.headers?.["x-ocg-token"], secrets.shimAccessToken)
    assert.deepStrictEqual(provider.models["xiaomi/MiMo-V2.5"]?.modalities?.input, ["text", "image", "pdf", "audio", "video"])
    assert.equal(provider.models["xiaomi/MiMo-V2.5"]?.capabilities?.audio?.supported, true)
    assert.equal(provider.models["xiaomi/MiMo-V2.5"]?.capabilities?.video?.supported, true)
    assert.equal(provider.models["xiaomi/MiMo-V2.5"]?.reasoning, true)

    const second = await runCli(["start", "--background"], ctx.env)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /already running|ya está corriendo|ya está corriendo en/i)
  })

  it("stops shim and watchdog cleanly", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const stop = await runCli(["stop"], ctx.env)
    assert.equal(stop.code, 0, stop.stderr)
    assert.match(stop.stdout, /stopped|detenido|No process found|No hay proceso/i)

    await waitFor(async () => !existsSync(ctx.paths.pidFile))
    await waitFor(async () => !existsSync(ctx.paths.watchdogPidFile))

    const healthAfterStop = await probeHealth(ctx.port, secrets.shimAccessToken)
    assert.equal(healthAfterStop, null)
  })

  it("shows shim/watchdog logs and follows appended lines", { timeout: 20000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const shimLogs = await runCli(["logs", "--lines", "5"], ctx.env)
    assert.equal(shimLogs.code, 0, shimLogs.stderr)
    assert.match(shimLogs.stdout, /Log:/i)
    assert.match(shimLogs.stdout, /LISTEN|COMPAT/i)

    const watchdogLogs = await runCli(["logs", "--watchdog", "--lines", "5"], ctx.env)
    assert.equal(watchdogLogs.code, 0, watchdogLogs.stderr)
    assert.match(watchdogLogs.stdout, /Watchdog log|Watchdog/i)
    assert.match(watchdogLogs.stdout, /WATCHDOG started/i)

    const follower = spawn(process.execPath, [cliEntry, "logs", "--watchdog", "--follow", "--lines", "1"], {
      cwd: repoDir,
      env: { ...process.env, ...ctx.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    cleanupTasks.push(async () => killChildProcess(follower))

    let stdout = ""
    follower.stdout.on("data", chunk => {
      stdout += String(chunk)
    })

    await waitFor(() => stdout.includes("Following") || stdout.includes("Siguiendo"))
    appendFileSync(ctx.paths.watchdogLogFile, `[${new Date().toISOString()}] WATCHDOG test follow line\n`, "utf8")
    await waitFor(() => stdout.includes("WATCHDOG test follow line"))
    await killChildProcess(follower)
  })

  it("restores the shim after a crash through watchdog recovery", { timeout: 25000 }, async () => {
    const mock = await startMockCatalogServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const originalPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
    assert.ok(originalPid > 0, "expected shim pid")

    killPid(originalPid)

    await waitFor(async () => {
      if (!existsSync(ctx.paths.pidFile)) return false
      const nextPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
      if (!Number.isInteger(nextPid) || nextPid <= 0 || nextPid === originalPid) return false
      const health = await probeHealth(ctx.port, secrets.shimAccessToken)
      return health?.ok === true
    }, { timeoutMs: 15000, intervalMs: 250 })

    const restartedPid = Number(readFileSync(ctx.paths.pidFile, "utf8").trim())
    assert.notEqual(restartedPid, originalPid)

    await waitFor(() => {
      if (!existsSync(ctx.paths.watchdogLogFile)) return false
      const content = readFileSync(ctx.paths.watchdogLogFile, "utf8")
      return /WATCHDOG restart OK/i.test(content)
    }, { timeoutMs: 5000, intervalMs: 150 })

    const watchdogLog = readFileSync(ctx.paths.watchdogLogFile, "utf8")
    assert.match(watchdogLog, /WATCHDOG restart OK/i)
  })
})

describe("ocg chat/completions integration", () => {
  it("bridges a non-stream text completion and preserves usage/meta", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      body: sseText([
        { type: "text-delta", text: "Hola " },
        { type: "text-delta", text: "mundo" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 11, outputTokens: 7 } },
      ]),
    })

    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      messages: [
        { role: "system", content: "Respondé en español." },
        { role: "user", content: "Decí hola mundo" },
      ],
      max_tokens: 123,
      temperature: 0.4,
    }, secrets.shimAccessToken)

    assert.equal(response.status, 200)
    assert.equal(response.json.model, "xiaomi/MiMo-V2.5")
    assert.equal(response.json.choices[0].message.content, "Hola mundo")
    assert.equal(response.json.choices[0].finish_reason, "stop")
    assert.equal(response.json.usage.prompt_tokens, 11)
    assert.equal(response.json.usage.completion_tokens, 7)
    assert.equal(response.json._meta.shim, "ocg")

    const upstream = mock.takeAlphaRequests()
    assert.equal(upstream.length, 1)
    assert.equal(upstream[0].headers.authorization, "Bearer test-commandcode-key")
    assert.equal(upstream[0].payload.params.model, "xiaomi/MiMo-V2.5")
    assert.equal(upstream[0].payload.params.max_tokens, 123)
    assert.equal(upstream[0].payload.params.temperature, 0.4)
    assert.equal(upstream[0].payload.params.system, "Respondé en español.")
    assert.deepStrictEqual(upstream[0].payload.params.messages, [
      { role: "user", content: "Decí hola mundo" },
    ])
  })

  it("returns upstream errors as OpenAI-style server errors", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 429,
      body: JSON.stringify({ error: { message: "Rate limited" } }),
      headers: { "Content-Type": "application/json" },
    })

    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      messages: [{ role: "user", content: "hola" }],
    }, secrets.shimAccessToken)

    assert.equal(response.status, 500)
    assert.match(response.json.error.message, /429/)
    assert.equal(response.json.error.type, "server_error")
  })

  it("rejects models outside the catalog", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "forbidden/model",
      messages: [{ role: "user", content: "hola" }],
    }, secrets.shimAccessToken)

    assert.equal(response.status, 400)
    assert.equal(response.json.error.type, "model_not_allowed")
  })

  it("translates tool calls in both directions", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      body: sseText([
        { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hola" } },
        { type: "finish", finishReason: "tool_use", totalUsage: { inputTokens: 20, outputTokens: 5 } },
      ]),
    })

    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      messages: [{ role: "user", content: "Usá la tool echo" }],
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo text",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
    }, secrets.shimAccessToken)

    assert.equal(response.status, 200)
    assert.equal(response.json.choices[0].finish_reason, "tool_calls")
    assert.equal(response.json.choices[0].message.tool_calls[0].id, "call_1")
    assert.equal(response.json.choices[0].message.tool_calls[0].function.name, "echo")
    assert.equal(response.json.choices[0].message.tool_calls[0].function.arguments, "{\"text\":\"hola\"}")
    assert.equal(response.json.choices[0].message.content, null)

    const upstream = mock.takeAlphaRequests()
    assert.equal(upstream[0].payload.params.tools[0].name, "echo")
    assert.deepStrictEqual(upstream[0].payload.params.tools[0].input_schema.required, ["text"])
  })

  it("converts image_url and data URL inputs for upstream multimodal payloads", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      body: sseText([
        { type: "text-delta", text: "imagen ok" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 3 } },
      ]),
    })

    const dataUrl = "data:image/png;base64,QUJDRA=="
    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describí ambas imágenes." },
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    }, secrets.shimAccessToken)

    assert.equal(response.status, 200)
    assert.equal(response.json.choices[0].message.content, "imagen ok")

    const upstream = mock.takeAlphaRequests()
    const content = upstream[0].payload.params.messages[0].content
    assert.equal(content[0].type, "text")
    assert.deepStrictEqual(content[1], {
      type: "image",
      source: {
        type: "url",
        url: "https://example.com/cat.png",
      },
    })
    assert.deepStrictEqual(content[2], {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "QUJDRA==",
      },
    })
  })

  it("streams SSE chunks for text responses", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      streamChunks: [
        "data: {\"type\":\"text-delta\",\"text\":\"Hola\"}\n\n",
        "data: {\"type\":\"text-delta\",\"text\":\" mundo\"}\n\n",
        "data: {\"type\":\"finish\",\"finishReason\":\"stop\",\"totalUsage\":{\"inputTokens\":4,\"outputTokens\":2}}\n\n",
        "data: [DONE]\n\n",
      ],
      chunkDelayMs: 20,
    })

    const streamed = await postJsonStream(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      stream: true,
      messages: [{ role: "user", content: "hola" }],
    }, secrets.shimAccessToken)

    assert.equal(streamed.status, 200)
    assert.match(streamed.text, /"role":"assistant"/)
    assert.match(streamed.text, /"content":"Hola"/)
    assert.match(streamed.text, /"content":" mundo"/)
    assert.match(streamed.text, /"finish_reason":"stop"/)
    assert.match(streamed.text, /data: \[DONE\]/)
  })

  it("streams tool call chunks when upstream emits tool-call events", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      streamChunks: [
        "data: {\"type\":\"tool-call\",\"toolCallId\":\"call_stream\",\"toolName\":\"echo\",\"input\":{\"text\":\"hola\"}}\n\n",
        "data: {\"type\":\"finish\",\"finishReason\":\"tool_use\",\"totalUsage\":{\"inputTokens\":9,\"outputTokens\":1}}\n\n",
        "data: [DONE]\n\n",
      ],
    })

    const streamed = await postJsonStream(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      stream: true,
      messages: [{ role: "user", content: "tool" }],
    }, secrets.shimAccessToken)

    assert.equal(streamed.status, 200)
    assert.match(streamed.text, /"tool_calls"/)
    assert.match(streamed.text, /"name":"echo"/)
    assert.match(streamed.text, /"finish_reason":"tool_calls"/)
  })

  it("survives upstream stream error events and closes the SSE stream", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      streamChunks: [
        "data: {\"type\":\"text-delta\",\"text\":\"Hola\"}\n\n",
        "data: {\"type\":\"error\",\"message\":\"boom\"}\n\n",
        "data: [DONE]\n\n",
      ],
    })

    const streamed = await postJsonStream(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      stream: true,
      messages: [{ role: "user", content: "hola" }],
    }, secrets.shimAccessToken)

    assert.equal(streamed.status, 200)
    assert.match(streamed.text, /"content":"Hola"/)
    assert.match(streamed.text, /"finish_reason":"stop"/)
    assert.match(streamed.text, /data: \[DONE\]/)
  })

  it("preserves assistant tool calls and tool results in upstream roundtrip payload", { timeout: 20000 }, async () => {
    const mock = await startMockCommandCodeServer()
    const ctx = createIsolatedCliContext(await getFreePort(), mock.port)
    registerCleanup(ctx, mock)

    await runCli(["start", "--background"], ctx.env)
    const secrets = readJson(ctx.paths.secretsFile)
    await waitForHealth(ctx.port, secrets.shimAccessToken)

    mock.enqueueAlphaResponse({
      status: 200,
      body: sseText([
        { type: "text-delta", text: "resultado final" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 7, outputTokens: 4 } },
      ]),
    })

    const response = await postJson(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      model: "xiaomi/MiMo-V2.5",
      messages: [
        { role: "user", content: "calculá" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_roundtrip",
              type: "function",
              function: {
                name: "sum",
                arguments: "{\"a\":1,\"b\":2}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_roundtrip",
          content: "{\"result\":3}",
        },
      ],
    }, secrets.shimAccessToken)

    assert.equal(response.status, 200)
    assert.equal(response.json.choices[0].message.content, "resultado final")

    const upstream = mock.takeAlphaRequests()
    assert.equal(upstream[0].payload.params.messages[1].role, "assistant")
    assert.equal(upstream[0].payload.params.messages[1].content[0].type, "tool-call")
    assert.equal(upstream[0].payload.params.messages[1].content[0].toolName, "sum")
    assert.deepStrictEqual(upstream[0].payload.params.messages[2], {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_roundtrip",
          toolName: "sum",
          output: {
            type: "text",
            value: "{\"result\":3}",
          },
        },
      ],
    })
  })
})

function createIsolatedCliContext(port, mockPort) {
  const root = mkdtempSync(join(tmpdir(), "ocg-integration-"))
  const userProfile = join(root, "user")
  mkdirSync(userProfile, { recursive: true })

  return {
    root,
    port,
    env: {
      OCG_HOME: root,
      USERPROFILE: userProfile,
      COMMANDCODE_API_KEY: "test-commandcode-key",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${mockPort}`,
      SHIM_PORT: String(port),
      OCG_WATCHDOG_INTERVAL_MS: "250",
      OCG_WATCHDOG_MAX_FAILURES: "2",
      OCG_WATCHDOG_RESTART_DELAY_MS: "250",
      OCG_WATCHDOG_READY_TIMEOUT_MS: "2500",
    },
    paths: {
      dataDir: join(root, "ocg"),
      secretsFile: join(root, "ocg", "secrets.json"),
      pidFile: join(root, "ocg", "shim.pid"),
      watchdogPidFile: join(root, "ocg", "watchdog.pid"),
      logFile: join(root, "ocg", "logs", "shim.log"),
      watchdogLogFile: join(root, "ocg", "logs", "watchdog.log"),
      opencodeConfigFile: join(userProfile, ".config", "opencode", "opencode.json"),
    },
  }
}

function seedOpenCodeConfig(file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2), "utf8")
}

function registerCleanup(ctx, mock) {
  cleanupTasks.push(async () => {
    try {
      await runCli(["stop"], ctx.env, { timeoutMs: 8000 })
    } catch {
      // ignore
    }
    killPid(readPidFile(ctx.paths.pidFile))
    killPid(readPidFile(ctx.paths.watchdogPidFile))
    rmSync(ctx.root, { recursive: true, force: true })
    await mock.close()
  })
}

function readPidFile(file) {
  if (!existsSync(file)) return null
  const value = Number(readFileSync(file, "utf8").trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

async function runCli(args, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""

    const timer = setTimeout(() => {
      killChildProcess(child).finally(() => reject(new Error(`CLI timeout: ${args.join(" ")}`)))
    }, timeoutMs)

    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", chunk => {
      stderr += String(chunk)
    })
    child.on("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function waitForHealth(port, token) {
  let last = null
  await waitFor(async () => {
    last = await probeHealth(port, token)
    return last?.ok === true
  }, { timeoutMs: 12000, intervalMs: 250 })
  return last
}

async function probeHealth(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-ocg-token": token },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  throw new Error("Timed out waiting for condition")
}

async function startMockCatalogServer() {
  return await startMockCommandCodeServer()
}

async function startMockCommandCodeServer() {
  const alphaRequests = []
  const alphaResponses = []
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/provider/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: [
          {
            id: "xiaomi/MiMo-V2.5",
            display_name: "MiMo V2.5",
            context_length: 200000,
            capabilities: {
              vision: true,
              pdf: true,
              audio: true,
              video: true,
            },
            tags: ["reasoning"],
          },
        ],
      }))
      return
    }

    if (req.method === "POST" && req.url === "/alpha/generate") {
      const body = await readRequestBody(req)
      alphaRequests.push({
        headers: req.headers,
        payload: body ? JSON.parse(body) : null,
      })
      const next = alphaResponses.shift() || {
        status: 200,
        body: sseText([
          { type: "text-delta", text: "OK" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]),
      }

      if (Array.isArray(next.streamChunks)) {
        res.writeHead(next.status || 200, { "Content-Type": "text/event-stream; charset=utf-8", ...(next.headers || {}) })
        for (const chunk of next.streamChunks) {
          res.write(chunk)
          if (next.chunkDelayMs) {
            await new Promise(resolve => setTimeout(resolve, next.chunkDelayMs))
          }
        }
        res.end()
        return
      }

      res.writeHead(next.status || 200, { "Content-Type": "text/plain; charset=utf-8", ...(next.headers || {}) })
      res.end(next.body || "")
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    port: address.port,
    enqueueAlphaResponse(next) {
      alphaResponses.push(next)
    },
    takeAlphaRequests() {
      return alphaRequests.splice(0, alphaRequests.length)
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function getFreePort() {
  const server = createServer((_, res) => {
    res.writeHead(204)
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return address.port
}

function killPid(pid) {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    // ignore
  }
}

async function killChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    // ignore
  }
  await new Promise(resolve => child.once("close", resolve))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

async function postJson(url, payload, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ocg-token": token,
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: JSON.parse(text),
  }
}

async function postJsonStream(url, payload, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ocg-token": token,
    },
    body: JSON.stringify(payload),
  })
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  }
}

function sseText(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n`).join("\n")
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", chunk => {
      body += String(chunk)
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}
