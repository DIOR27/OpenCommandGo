import { execFile, execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { resolveContextWindow } from "./context-windows.js"

/**
 * Resolve the `cmd` binary path via PATH lookup or `sh -lc 'command -v cmd'`.
 * Returns the absolute path string, or null if not found.
 */
export function resolveCmdBinary() {
  // Allow skipping via env var (used in test environments)
  if (process.env.OCG_SKIP_CMD_CATALOG === "1") return null

  // 1) Fast PATH directory scan
  const pathEnv = process.env.PATH || ""
  for (const dir of pathEnv.split(":")) {
    try {
      const candidate = join(dir, "cmd")
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // try next
    }
  }

  // 2) Fallback: sh -lc 'command -v cmd' (handles shell-managed paths)
  try {
    const result = execFileSync("sh", ["-lc", "command -v cmd"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const path = String(result || "").trim()
    if (path) {
      // Verify it's executable
      try {
        accessSync(path, constants.X_OK)
        return path
      } catch {
        // path might be a shell alias, skip
      }
    }
  } catch {
    // not found via shell either
  }

  return null
}

/**
 * Run `cmd --list-models` and return the raw stdout text.
 * @param {{ cmdPath: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function fetchCmdModelList({ cmdPath, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    execFile(cmdPath, ["--list-models"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Parse `cmd --list-models` stdout into structured model entries.
 * Format:
 *   Available models  ·  35 models
 *
 *   Open Source
 *   ────────────────────────────────────────────────────────────────
 *   model-id  Description text
 *
 * @param {string} stdout - Raw output from `cmd --list-models`
 * @returns {Array<{ id: string, name: string, description: string, section: string }>}
 */
export function parseCmdModelList(stdout) {
  const lines = stdout.split("\n")
  const models = []
  let currentSection = null

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue

    // Skip header line
    if (/^Available models/i.test(line)) continue

    // Skip separator lines (unicode box drawing or ASCII dashes)
    if (/^[─\-═]+$/.test(line)) continue

    // Try to match as a model line: <model-id>  <description> (2+ spaces separator)
    const modelMatch = line.match(/^(\S+)\s{2,}(.+)/)
    if (modelMatch && currentSection) {
      models.push({
        id: modelMatch[1],
        name: modelMatch[1],
        description: modelMatch[2].trim(),
        section: currentSection,
      })
      continue
    }

    // Otherwise treat as a section header
    currentSection = line.trim()
  }

  return models
}

/**
 * Infer capabilities from a model's description string.
 * Keyword-based, case-insensitive, substring matching.
 *
 * @param {string} description - Model description from cmd output
 * @param {string} modelId - Model ID (for future use, currently informational)
 * @returns {{ vision: {supported: boolean|null, source: string|null}, pdf: {...}, audio: {...}, video: {...}, reasoning: {...}, hasImage: boolean, hasReasoning: boolean }}
 */
export function inferCmdDescriptionCapabilities(description, modelId) {
  const desc = (description || "").toLowerCase()

  const hasVision = desc.includes("vision")
  const hasMultimodal = /multimodal|multi-?mode|multimodality|multimedia/.test(desc)
  const hasReasoning = desc.includes("reasoning")
  const hasAudio = desc.includes("audio") || desc.includes("voice")
  const hasVideo = desc.includes("video")

  // multimodal implies image + audio + video support
  const imageSupport = hasVision || hasMultimodal
  const audioSupport = hasAudio || hasMultimodal
  const videoSupport = hasVideo || hasMultimodal

  return {
    vision: {
      supported: imageSupport || null,
      source: hasVision ? "cmd:desc.vision" : hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    pdf: {
      supported: hasMultimodal ? true : null,
      source: hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    audio: {
      supported: audioSupport || null,
      source: hasAudio ? "cmd:desc.audio" : hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    video: {
      supported: videoSupport || null,
      source: hasVideo ? "cmd:desc.video" : hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    reasoning: {
      supported: hasReasoning ? true : null,
      source: hasReasoning ? "cmd:desc.reasoning" : null,
    },
    hasImage: imageSupport,
    hasReasoning,
  }
}

/**
 * Extract context window from description text.
 * Parses patterns like "1M context", "100K context", "long-context" (no number).
 *
 * @param {string} description - Model description
 * @returns {number|null} - Context window in tokens, or null
 */
export function extractCmdContextWindow(description) {
  const desc = (description || "").toLowerCase()

  // Explicit number pattern: "1M context", "100K tokens", "512k"
  const numberMatch = desc.match(/(\d+(?:\.\d+)?)\s*(m|k|mb|kb)\s*(?:context|tokens?)?/)
  if (numberMatch) {
    const num = parseFloat(numberMatch[1])
    const unit = numberMatch[2].toLowerCase()
    if (unit.startsWith("m")) return Math.round(num * 1048576)
    if (unit.startsWith("k")) return Math.round(num * 1024)
    return Math.round(num)
  }

  // Bare number near context: "context 100000", "ctx 64000"
  const bareMatch = desc.match(/(?:context|ctx)\s*[:\s]+\s*(\d{5,})/)
  if (bareMatch) return parseInt(bareMatch[1], 10)

  // No explicit number found
  return null
}

/**
 * Build catalog rows from parsed cmd models, optionally filtered by section.
 * Compatible with existing catalog format { id, name, context_length, tags, catalog_capabilities }.
 *
 * @param {Array<{ id: string, name: string, description: string, section: string }>} parsedModels
 * @param {{ filterSection?: string }} options
 * @returns {Array<{ id: string, name: string, context_length: number|null, tags: string[], catalog_capabilities: object }>}
 */
export function buildCmdCatalogRows(parsedModels, { filterSection } = {}) {
  const filtered = filterSection
    ? parsedModels.filter(m => m.section === filterSection)
    : parsedModels

  return filtered.map(model => {
    const capabilities = inferCmdDescriptionCapabilities(model.description, model.id)

    // Priority: 1) description-based context, 2) fallback registry/hints, 3) default
    const descContext = extractCmdContextWindow(model.description)
    const contextWindow = descContext || resolveContextWindow(model.id)

    return {
      id: model.id,
      name: model.name,
      context_length: contextWindow,
      tags: [],
      catalog_capabilities: capabilities,
    }
  })
}
