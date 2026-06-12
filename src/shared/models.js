export const MODELS = [
  ["moonshotai/Kimi-K2.6", "Kimi K2.6"],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5"],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max"],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus"],
  ["Qwen/Qwen3.7-Max-Free", "Qwen 3.7 Max Free"],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3"],
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7"],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["zai-org/GLM-5.1", "GLM-5.1"],
  ["zai-org/GLM-5", "GLM-5"],
]

export const MODEL_SET = new Set(MODELS.map(([id]) => id))
