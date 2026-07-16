export const COMMANDCODE_PROVIDER = {
  id: "commandcode",
  legacyIds: ["ocg"],
  name: "Command Code",
  routePrefix: "commandcode",
  legacyRoutePrefixes: ["ocg"],
}

export const FALLBACK_MODEL_REGISTRY = [
  { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", contextWindow: 262144 },
  { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code Highspeed", contextWindow: 262144 },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", contextWindow: 262144 },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", contextWindow: 262144 },
  { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", contextWindow: 262144 },
  { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus", contextWindow: 262144 },
  { id: "Qwen/Qwen3.7-Max-Free", name: "Qwen 3.7 Max Free", contextWindow: 262144 },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview", contextWindow: 262144 },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus", contextWindow: 262144 },
  { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", contextWindow: 200000 },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", contextWindow: 204800 },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 196000 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 200000 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 200000 },
  { id: "zai-org/GLM-5.2", name: "GLM-5.2", contextWindow: 200000 },
  { id: "zai-org/GLM-5.2-Fast", name: "GLM-5.2 Fast", contextWindow: 200000 },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1", contextWindow: 200000 },
  { id: "zai-org/GLM-5", name: "GLM-5", contextWindow: 200000 },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextWindow: 200000 },
  { id: "xiaomi/mimo-v2.5", name: "MiMo V2.5", contextWindow: 200000 },
  { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash", contextWindow: 200000 },
  { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash", contextWindow: 200000 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", contextWindow: 200000 },
]

const MODEL_FAMILY_HINTS = [
  {
    prefix: "moonshotai/kimi-k2",
    contextWindow: 262144,
    capabilities: { vision: true, pdf: true, video: true },
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "qwen/qwen3-7",
    contextWindow: 262144,
  },
  {
    prefix: "qwen/qwen3-6",
    contextWindow: 262144,
  },
  {
    prefix: "minimaxai/minimax-m2-7",
    contextWindow: 204800,
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "minimaxai/minimax-m2-5",
    contextWindow: 196000,
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "minimaxai/minimax-m3",
    contextWindow: 200000,
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "deepseek/deepseek-v4",
    contextWindow: 200000,
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "zai-org/glm-5",
    contextWindow: 200000,
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "xiaomi/mimo-v2-5-pro",
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "xiaomi/mimo-v2-5",
    capabilities: { vision: true, pdf: true },
    reasoning: true,
    reasoningToggle: true,
  },
  {
    prefix: "stepfun/step",
    contextWindow: 200000,
    reasoning: true,
  },
  {
    prefix: "nvidia/nemotron",
    reasoning: true,
  },
]

export const MODEL_CONTEXT_WINDOWS = Object.fromEntries(
  FALLBACK_MODEL_REGISTRY.map(model => [model.id.toLowerCase(), model.contextWindow]),
)

const INPUT_MODALITY_KEYS = [
  ["image", "vision"],
  ["pdf", "pdf"],
  ["audio", "audio"],
  ["video", "video"],
]

const EXACT_MODEL_LOOKUP = new Map(
  FALLBACK_MODEL_REGISTRY.map(model => [comparableCommandCodeModel(model.id), model]),
)

export function resolveBridgeInputModalities(compat) {
  const input = ["text"]
  for (const [modality, capability] of INPUT_MODALITY_KEYS) {
    if (resolveCapabilitySupport(compat, capability) === true && !input.includes(modality)) {
      input.push(modality)
    }
  }
  return input
}

export function resolveBridgeCapabilities(compat) {
  return {
    vision: resolveCapabilityEntry(compat, "vision"),
    pdf: resolveCapabilityEntry(compat, "pdf"),
    audio: resolveCapabilityEntry(compat, "audio"),
    video: resolveCapabilityEntry(compat, "video"),
  }
}

export function comparableCommandCodeModel(model) {
  return String(model || "").trim().toLowerCase().replace(/[._]/g, "-")
}

export function providerlessCommandCodeModel(model) {
  return comparableCommandCodeModel(model).split("/").pop() ?? comparableCommandCodeModel(model)
}

export function resolveFallbackContextWindow(model) {
  const hint = resolveFallbackModelHints(model)
  return typeof hint.contextWindow === "number" ? hint.contextWindow : null
}

export function resolveFallbackModelHints(model) {
  const comparable = comparableCommandCodeModel(model)
  const providerless = providerlessCommandCodeModel(model)
  const exact = EXACT_MODEL_LOOKUP.get(comparable) || EXACT_MODEL_LOOKUP.get(providerless)
  const family = MODEL_FAMILY_HINTS.find(entry => comparable.startsWith(entry.prefix) || providerless.startsWith(entry.prefix))

  return {
    contextWindow: exact?.contextWindow ?? family?.contextWindow ?? null,
    capabilities: {
      vision: exact?.capabilities?.vision ?? family?.capabilities?.vision ?? null,
      pdf: exact?.capabilities?.pdf ?? family?.capabilities?.pdf ?? null,
      audio: exact?.capabilities?.audio ?? family?.capabilities?.audio ?? null,
      video: exact?.capabilities?.video ?? family?.capabilities?.video ?? null,
    },
    reasoning: exact?.reasoning ?? family?.reasoning ?? null,
    reasoningToggle: exact?.reasoningToggle ?? family?.reasoningToggle ?? false,
  }
}

export function supportsKnownReasoningToggle(model) {
  return resolveFallbackModelHints(model).reasoningToggle === true
}

function resolveCapabilitySupport(compat, key) {
  if (!compat || typeof compat !== "object") return null
  const supported = compat?.capabilities?.[key]?.supported
  if (typeof supported === "boolean") return supported
  if (key === "vision" && compat?.image?.ok === true) return true
  return null
}

function resolveCapabilitySource(compat, key) {
  if (!compat || typeof compat !== "object") return null
  const source = compat?.capabilities?.[key]?.source
  if (typeof source === "string" && source.trim()) return source.trim()
  if (key === "vision" && compat?.image?.ok === true) return null
  return null
}

function resolveCapabilityEntry(compat, key) {
  return {
    supported: resolveCapabilitySupport(compat, key),
    source: resolveCapabilitySource(compat, key),
  }
}
