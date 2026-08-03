// @ts-check
/**
 * Persistent per-model enablement store.
 * Mirrors manual-capabilities.json: an independent file applied at sync.
 * Defaults when no store exists: open-source models enabled, premium disabled.
 * Stored at <dataDir>/model-enablement.json
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { getPaths, ensureDir } from "./paths.js"

const STORE_VERSION = 1

/**
 * Read the enablement store.
 * Absent file -> defaults { enabled: {} } with no forced write.
 * Corrupt JSON -> defaults + a console warning, never crashes.
 * @returns {{ version: number, enabled: Record<string, boolean> }}
 */
export function readEnablement() {
  const file = getPaths().enablementFile
  if (!existsSync(file)) return { version: STORE_VERSION, enabled: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const enabled = parsed?.enabled && typeof parsed.enabled === "object"
      ? parsed.enabled
      : {}
    return { version: STORE_VERSION, enabled }
  } catch {
    console.warn(`[ocg] model-enablement.json is corrupt; using defaults.`)
    return { version: STORE_VERSION, enabled: {} }
  }
}

/**
 * Whether a model is enabled.
 * Explicit store entry wins; otherwise open-source defaults to enabled,
 * premium to disabled. A missing store behaves like defaults.
 * @param {string} modelId
 * @param {"premium"|"open-source"} tier
 * @param {{ enabled: Record<string, boolean> }|undefined} store
 * @returns {boolean}
 */
export function resolveEnabled(modelId, tier, store) {
  if (store?.enabled && Object.prototype.hasOwnProperty.call(store.enabled, modelId)) {
    return store.enabled[modelId] === true
  }
  return tier === "open-source"
}

/**
 * Keep only catalog rows whose model is enabled.
 * @param {Array<{ id: string, tier?: "premium"|"open-source" }>} rows
 * @param {{ enabled: Record<string, boolean> }|undefined} store
 * @returns {Array<{ id: string, tier?: "premium"|"open-source" }>}
 */
export function filterEnabledModels(rows, store) {
  return rows.filter(row => resolveEnabled(row.id, row.tier || "premium", store))
}

/**
 * Persist the explicit enabled flag for a model. Idempotent write.
 * @param {string} modelId
 * @param {boolean} value
 */
export function setEnabled(modelId, value) {
  const store = readEnablement()
  if (value) store.enabled[modelId] = true
  else store.enabled[modelId] = false
  writeEnablement(store)
}

/**
 * Flip the explicit enabled flag for a model.
 * @param {string} modelId
 */
export function toggleEnablement(modelId) {
  setEnabled(modelId, !resolveEnabled(modelId, "premium", readEnablement()))
}

/**
 * Remove all explicit toggles; defaults apply again.
 */
export function resetEnablement() {
  const file = getPaths().enablementFile
  if (existsSync(file)) rmSync(file, { force: true })
}

function writeEnablement(store) {
  const file = getPaths().enablementFile
  ensureDir(getPaths().dataDir)
  writeFileSync(file, JSON.stringify({ version: STORE_VERSION, enabled: store.enabled }, null, 2), "utf8")
}
