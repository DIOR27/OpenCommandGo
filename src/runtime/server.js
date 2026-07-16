import { createServer } from "node:http"
import { getPaths, ensureDir } from "../config/paths.js"
import { clearPid, getRuntimeSettings, readCompatibilityMatrix, writeCompatibilityMatrix, writePid } from "../config/store.js"
import { COMMANDCODE_PROVIDER, resolveBridgeInputModalities } from "../shared/models.js"
import { t } from "../shared/i18n.js"
import { buildOpenAICompletion, callCommandCodeAlpha, startCommandCodeAlphaStream, streamOpenAIResponse, summarizeIncomingMessages } from "./chat-bridge.js"
import { createCatalogController } from "./catalog-runtime.js"
import { isLoopbackHost, json, openAIError, readJson, requireShimAuth } from "./http-utils.js"
import { installProcessLifecycleHandlers } from "./lifecycle.js"
import { runtimeLog } from "./runtime-log.js"

let currentServer = null

const commandCodeCatalogController = createCatalogController({
  initialCompatibilityMatrix: readCompatibilityMatrix("commandcode"),
  writeCompatibilityMatrix: matrix => writeCompatibilityMatrix(matrix, "commandcode"),
  log,
})

export async function refreshModelCatalogNow(options = {}) {
  const settings = getRuntimeSettings()
  const provider = typeof options.provider === "string" ? options.provider : "all"

  if (provider === "commandcode") {
    const matrix = await commandCodeCatalogController.refreshNow(settings, options)
    return { commandcode: matrix }
  }

  const commandcode = await commandCodeCatalogController.refreshNow(settings, options)
  return { commandcode }
}

export async function startServer() {
  if (currentServer) return currentServer

  const settings = getRuntimeSettings()
  const compatibilityMatrix = commandCodeCatalogController.getCompatibilityMatrix()
  if (!settings.allowRemoteHost && !isLoopbackHost(settings.host)) {
    throw new Error(t("error.host_not_allowed", settings.host))
  }

  const paths = getPaths()
  ensureDir(paths.logDir)

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)

      if (req.method === "GET" && url.pathname === "/health") {
        if (!requireShimAuth(req, res, settings)) return
        const compatibilityMatrix = commandCodeCatalogController.getCompatibilityMatrix()
        const availableCatalog = commandCodeCatalogController.getAvailableCatalog()
        return json(res, 200, {
          ok: true,
          provider: "opencg-cli",
          host: settings.host,
          port: settings.port,
          models: availableCatalog.map(({ id, name }) => ({ id, name })),
          compatibility_updated_at: compatibilityMatrix.updated_at || null,
          providers: {
            commandcode: {
              models: availableCatalog.length,
              updated_at: compatibilityMatrix.updated_at || null,
            },
          },
        })
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        if (!requireShimAuth(req, res, settings)) return
        log("SHUTDOWN requested via /shutdown endpoint")
        json(res, 200, { ok: true, message: "Shutting down" })
        setImmediate(() => {
          clearPid()
          if (currentServer) {
            currentServer.close(() => {
              process.exit(0)
            })
          } else {
            process.exit(0)
          }
        })
        return
      }

      if (req.method === "GET" && url.pathname === "/compatibility") {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          commandcode: commandCodeCatalogController.getCompatibilityMatrix(),
        })
      }

      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/ocg/v1/models")) {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          object: "list",
          data: commandCodeCatalogController.buildModelList(),
        })
      }

      if (req.method === "GET" && url.pathname === `/${COMMANDCODE_PROVIDER.routePrefix}/v1/models`) {
        if (!requireShimAuth(req, res, settings)) return
        return json(res, 200, {
          object: "list",
          data: commandCodeCatalogController.buildModelList(),
        })
      }

      if (req.method === "POST" && (
        url.pathname === "/v1/chat/completions"
        || url.pathname === "/ocg/v1/chat/completions"
        || url.pathname === `/${COMMANDCODE_PROVIDER.routePrefix}/v1/chat/completions`
      )) {
        if (!requireShimAuth(req, res, settings)) return
        if (!settings.commandCodeApiKey) {
          return json(res, 500, openAIError("missing_api_key", t("error.missing_api_key")))
        }

        const body = await readJson(req)
        if (!body || typeof body !== "object") {
          return json(res, 400, openAIError("invalid_request_error", "Body JSON inválido"))
        }
        log(`REQUEST raw model=${body.model || ""} content_summary=${summarizeIncomingMessages(body.messages)}`)

        const model = typeof body.model === "string" ? body.model.trim() : ""
        const catalogEntry = commandCodeCatalogController.getAvailableCatalog().find(entry => entry.id === model)
        if (!catalogEntry) {
          return json(res, 400, openAIError("model_not_allowed", `Modelo no permitido: ${model || "(vacío)"}`))
        }

        const compat = compatibilityMatrix?.models?.[model]
        if (!resolveBridgeInputModalities(compat).includes("image") && requestHasImage(body.messages)) {
          log(`REQUEST image forwarded model=${model} note=text_only_in_catalog_may_still_accept`)
        }

        if (body.stream === true) {
          const upstream = await startCommandCodeAlphaStream(body, model, settings, { log })
          return streamOpenAIResponse(res, model, upstream, { log })
        }

        const upstream = await callCommandCodeAlpha(body, model, settings, { log })
        return json(res, 200, buildOpenAICompletion(model, upstream))
      }

      json(res, 404, openAIError("not_found", `Ruta no soportada: ${req.method} ${url.pathname}`))
    } catch (error) {
      log(`ERROR ${error instanceof Error ? error.stack || error.message : String(error)}`)
      json(res, 500, openAIError("server_error", error instanceof Error ? error.message : "Error interno"))
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(settings.port, settings.host, resolve)
  })

  currentServer = server
  writePid(process.pid)
  installProcessLifecycleHandlers({ clearPid })

  log(`LISTEN http://${settings.host}:${settings.port}`)
  console.log(t("server.listening", settings.host, settings.port))
  commandCodeCatalogController.schedule(settings)
  return server
}

function requestHasImage(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const content = message.content
    const parts = typeof content === "string" ? [] : Array.isArray(content) ? content : []
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      if (part.type === "image" || part.type === "image_url" || part.type === "input_image") return true
    }
  }
  return false
}

function log(line) {
  runtimeLog(line)
}
