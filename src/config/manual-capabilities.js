// @ts-check
/**
 * Persistent manual capability overrides for models.
 * Survives any refresh (catalog, probe, full).
 * Stored at ~/.config/ocg/manual-capabilities.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths, ensureDir } from "./paths.js"

const CAPABILITIES = ["vision", "pdf", "audio", "video", "reasoning"]
const OVERRIDE_SOURCE = "manual_override"

/**
 * @returns {string}
 */
function overridesFile() {
  const paths = getPaths()
  return join(paths.dataDir, "manual-capabilities.json")
}

/**
 * Read stored overrides.
 * @returns {Record<string, Record<string, boolean>>}
 */
export function readManualCapabilities() {
  const file = overridesFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

/**
 * Set a single capability override for a model.
 * @param {string} modelId
 * @param {string} capability - one of vision, pdf, audio, video, reasoning
 * @param {boolean|null} value - null to remove the override
 */
export function setManualCapability(modelId, capability, value) {
  const all = readManualCapabilities()
  if (!all[modelId]) all[modelId] = {}
  if (value === null) {
    delete all[modelId][capability]
    if (Object.keys(all[modelId]).length === 0) delete all[modelId]
  } else {
    all[modelId][capability] = value
  }
  const file = overridesFile()
  ensureDir(getPaths().dataDir)
  writeFileSync(file, JSON.stringify(all, null, 2), "utf8")
}

/**
 * Patch a compatibility matrix models dict with manual overrides.
 * Mutates entries in-place. Call after matrix is built, before sync.
 * @param {Record<string, any>} models - compatibilityMatrix.models
 */
export function applyManualOverrides(models) {
  if (!models || typeof models !== "object") return
  const overrides = readManualCapabilities()
  for (const [modelId, caps] of Object.entries(overrides)) {
    const entry = models[modelId]
    if (!entry || typeof entry !== "object") continue
    if (!entry.capabilities) entry.capabilities = {}
    for (const cap of CAPABILITIES) {
      if (caps[cap] === undefined) continue
      if (cap === "vision") {
        entry.capabilities.vision = {
          supported: caps[cap],
          source: OVERRIDE_SOURCE,
        }
        entry.image = entry.image || {}
        entry.image.ok = caps[cap]
        entry.image.source = OVERRIDE_SOURCE
        entry.image.output_chars = entry.image.output_chars || 0
      } else {
        entry.capabilities[cap] = {
          supported: caps[cap],
          source: OVERRIDE_SOURCE,
        }
      }
    }
  }
}

/**
 * Get overrides for a specific model.
 * @param {string} modelId
 * @returns {Record<string, boolean>}
 */
export function getModelOverrides(modelId) {
  const all = readManualCapabilities()
  return all[modelId] || {}
}
