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
  const hasMultimodal = /multimodal|multi-?mode|multimodality/.test(desc)
  const hasReasoning = desc.includes("reasoning")

  return {
    vision: {
      supported: hasVision || hasMultimodal || null,
      source: hasVision ? "cmd:desc.vision" : hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    pdf: {
      supported: hasMultimodal ? true : null,
      source: hasMultimodal ? "cmd:desc.multimodal" : null,
    },
    audio: { supported: null, source: null },
    video: { supported: null, source: null },
    reasoning: {
      supported: hasReasoning ? true : null,
      source: hasReasoning ? "cmd:desc.reasoning" : null,
    },
    hasImage: hasVision || hasMultimodal,
    hasReasoning,
  }
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
    return {
      id: model.id,
      name: model.name,
      context_length: resolveContextWindow(model.id),
      tags: [],
      catalog_capabilities: capabilities,
    }
  })
}
