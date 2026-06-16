export const COMMAND_CODE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]

export function comparableCommandCodeModel(model) {
  return String(model || "").trim().toLowerCase().replace(/[._]/g, "-")
}

export function providerlessCommandCodeModel(model) {
  return comparableCommandCodeModel(model).split("/").pop() ?? comparableCommandCodeModel(model)
}

export function isCommandCodeClaudeModel(model) {
  return comparableCommandCodeModel(model).includes("claude")
}

function isCommandCodeClaudeHaiku(model) {
  const normalized = comparableCommandCodeModel(model)
  return normalized.includes("claude") && normalized.includes("haiku")
}

function isCommandCodeClaudeOpusOrSonnet(model) {
  const normalized = comparableCommandCodeModel(model)
  return normalized.includes("claude") && (normalized.includes("opus") || normalized.includes("sonnet"))
}

function isCommandCodeGptModel(model) {
  const leaf = providerlessCommandCodeModel(model)
  return leaf.startsWith("gpt-") || leaf.includes("codex")
}

function isGpt54Mini(model) {
  const leaf = providerlessCommandCodeModel(model)
  return leaf === "gpt-5-4-mini" || leaf.startsWith("gpt-5-4-mini-")
}

export function commandCodeEffortLevelsForModel(model) {
  if (isCommandCodeClaudeHaiku(model)) return []
  if (isCommandCodeClaudeOpusOrSonnet(model)) return [...COMMAND_CODE_EFFORT_LEVELS]
  if (isCommandCodeGptModel(model)) {
    return isGpt54Mini(model)
      ? ["low", "medium", "high"]
      : ["low", "medium", "high", "xhigh"]
  }
  return []
}

export function supportsCommandCodeEffortSelection(model, tags) {
  if (commandCodeEffortLevelsForModel(model).length > 0) return true
  if (!Array.isArray(tags)) return false
  return tags.includes("reasoning")
}

export function normalizeCommandCodeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase()
  return COMMAND_CODE_EFFORT_LEVELS.includes(normalized) ? normalized : null
}
