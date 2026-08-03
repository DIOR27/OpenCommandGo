// @ts-check
/**
 * Catalog tier derivation for Command Code models.
 * A model's tier is derived from its `cmd --list-models` section; when no
 * section is available (HTTP/CI path) it falls back to a family heuristic.
 * Unknown future sections default to premium (opt-in, safe default).
 */

export const PREMIUM_SECTIONS = new Set([
  "Anthropic",
  "OpenAI",
  "Google",
  "Sakana",
  "Meta",
  "xAI",
])

const PREMIUM_FAMILY_PATTERNS = [/claude/, /^gpt-/, /^o1/, /^o3/, /^o4/, /codex/]

/**
 * True when the model id belongs to a known premium family.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isPremiumFamily(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase()
  if (!normalized) return false
  const leaf = normalized.split("/").pop()
  return PREMIUM_FAMILY_PATTERNS.some(pattern => pattern.test(leaf))
}

/**
 * Derive { section, tier } for a catalog row.
 * Unknown/future sections default to premium (FR-01 safe default).
 * @param {string|undefined} section - cmd --list-models section
 * @param {string} modelId
 * @returns {{ section: string|null, tier: "premium"|"open-source" }}
 */
export function deriveCatalogTier(section, modelId) {
  const resolved = typeof section === "string" && section.trim() ? section.trim() : null
  const tier =
    resolved && PREMIUM_SECTIONS.has(resolved)
      ? "premium"
      : resolved && resolved !== "Open Source"
        ? "premium"
        : isPremiumFamily(modelId)
          ? "premium"
          : "open-source"
  return { section: resolved, tier }
}
