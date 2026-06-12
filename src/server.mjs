import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const HOST = process.env.CC_GO_SHIM_HOST || '127.0.0.1'
const PORT = Number(process.env.CC_GO_SHIM_PORT || 4310)
const COMMAND_CODE_API_BASE_URL = 'https://api.commandcode.ai'
const COMMAND_CODE_ALPHA_GENERATE_URL = `${COMMAND_CODE_API_BASE_URL}/alpha/generate`
const COMMAND_CODE_CLI_VERSION = process.env.COMMAND_CODE_CLI_VERSION || '0.32.2'
const COMMAND_CODE_CACHE_CONTROL = { type: 'ephemeral' }

const SUPPORTED_MODELS = [
  {
    id: 'moonshotai/Kimi-K2.6',
    name: 'Kimi K2.6 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'moonshotai/Kimi-K2.5',
    name: 'Kimi K2.5 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'Qwen/Qwen3.7-Max',
    name: 'Qwen 3.7 Max (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'Qwen/Qwen3.7-Plus',
    name: 'Qwen 3.7 Plus (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'Qwen/Qwen3.7-Max-Free',
    name: 'Qwen 3.7 Max Free (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'MiniMaxAI/MiniMax-M3',
    name: 'MiniMax M3 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.7',
    name: 'MiniMax M2.7 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax M2.5 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'zai-org/GLM-5.1',
    name: 'GLM 5.1 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
  {
    id: 'zai-org/GLM-5',
    name: 'GLM 5 (Command Code Go)',
    contextWindow: 262144,
    maxOutputTokens: 65536,
  },
]

const MODEL_MAP = new Map(SUPPORTED_MODELS.map(model => [model.id, model]))
const environmentContextBySession = new Map()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, provider: 'commandcode-go-shim' })
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: SUPPORTED_MODELS.map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'commandcode-go-shim',
        })),
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const apiKey = loadCommandCodeApiKey()
      if (!apiKey) {
        return openAIError(res, 500, 'No Command Code auth found. Run `cmd auth login` first.')
      }

      const body = await readJsonBody(req)
      const model = typeof body.model === 'string' ? body.model : ''
      if (!MODEL_MAP.has(model)) {
        return openAIError(res, 400, `Unsupported model: ${model || '(missing)'}`)
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return openAIError(res, 400, 'messages must be a non-empty array')
      }

      if (body.n && body.n !== 1) {
        return openAIError(res, 400, 'n > 1 is not supported')
      }

      const normalized = normalizeOpenAIMessages(body.messages)
      const stream = body.stream !== false
      const sessionId = randomUUID()
      const payload = buildAlphaPayload({
        model,
        messages: normalized.messages,
        system: normalized.system,
        tools: Array.isArray(body.tools) ? body.tools : [],
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
        sessionId,
      })

      const upstream = await fetch(COMMAND_CODE_ALPHA_GENERATE_URL, {
        method: 'POST',
        headers: buildAlphaHeaders(apiKey, sessionId),
        body: JSON.stringify(payload),
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        return openAIError(res, upstream.status, normalizeUpstreamError(detail) || 'Command Code upstream error')
      }

      if (!upstream.body) {
        return openAIError(res, 502, 'Command Code returned no body')
      }

      if (stream) {
        return streamOpenAIResponse(res, upstream.body, model)
      }

      const completion = await collectOpenAIResponse(upstream.body, model)
      return json(res, 200, completion)
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return openAIError(res, 500, error instanceof Error ? error.message : String(error))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Command Code Go shim listening on http://${HOST}:${PORT}`)
})

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload, null, 2))
}

function openAIError(res, status, message) {
  return json(res, status, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function normalizeOpenAIMessages(messages) {
  const systemParts = []
  const toolNames = new Map()
  const normalized = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : 'user'
    if (role === 'system') {
      const text = contentToText(message.content)
      if (text) systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      normalized.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.tool_call_id || '',
          ...(toolNames.get(message.tool_call_id || '') ? { toolName: toolNames.get(message.tool_call_id || '') } : {}),
          output: {
            type: 'text',
            value: contentToText(message.content),
          },
        }],
      })
      continue
    }

    if (role === 'assistant') {
      const blocks = []
      const assistantText = contentToText(message.content)
      if (assistantText) blocks.push({ type: 'text', text: assistantText })

      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const id = toolCall.id || `toolu_${randomUUID()}`
          const name = toolCall.function?.name || 'tool'
          toolNames.set(id, name)
          blocks.push({
            type: 'tool-call',
            toolCallId: id,
            toolName: name,
            input: parseJsonLoose(toolCall.function?.arguments) || {},
          })
        }
      }

      normalized.push({ role: 'assistant', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks })
      continue
    }

    const userText = contentToText(message.content)
    normalized.push({ role: 'user', content: userText })
  }

  return {
    system: systemParts.join('\n\n').trim() || undefined,
    messages: ensureMessageCacheControl(normalized),
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function ensureMessageCacheControl(messages) {
  if (messages.some(messageHasCacheControl)) return messages
  const userIndexes = messages
    .map((message, index) => message.role === 'user' && message.content ? index : -1)
    .filter(index => index >= 0)
  if (userIndexes.length < 2) return messages

  const target = messages[userIndexes[userIndexes.length - 2]]
  if (!target) return messages
  if (typeof target.content === 'string') {
    target.content = [{ type: 'text', text: target.content, cache_control: COMMAND_CODE_CACHE_CONTROL }]
    return messages
  }
  if (!Array.isArray(target.content)) return messages

  for (let index = target.content.length - 1; index >= 0; index -= 1) {
    const block = target.content[index]
    if (!block || typeof block !== 'object') continue
    target.content[index] = { ...block, cache_control: COMMAND_CODE_CACHE_CONTROL }
    break
  }
  return messages
}

function messageHasCacheControl(message) {
  return Array.isArray(message.content) && message.content.some(block => block && typeof block === 'object' && 'cache_control' in block)
}

function buildAlphaPayload({ model, messages, system, tools, temperature, maxTokens, sessionId }) {
  const params = {
    stream: true,
    model,
    messages,
    ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
  }

  if (system) params.system = system
  if (Array.isArray(tools) && tools.length > 0) {
    params.tools = tools.map(tool => ({
      name: tool.function?.name || tool.name,
      ...(tool.function?.description ? { description: tool.function.description } : {}),
      input_schema: tool.function?.parameters || tool.input_schema || {},
    }))
    if (!params.tools.some(tool => tool.cache_control)) {
      params.tools[params.tools.length - 1].cache_control = COMMAND_CODE_CACHE_CONTROL
    }
  }

  return {
    mode: 'custom-agent',
    config: getEnvironmentContext(sessionId),
    memory: '',
    threadId: sessionId,
    params,
  }
}

function buildAlphaHeaders(apiKey, sessionId) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': COMMAND_CODE_CLI_VERSION,
    'x-co-flag': 'false',
    'x-project-slug': projectSlug(),
    'x-session-id': sessionId,
    'x-taste-learning': 'false',
  }
}

function loadCommandCodeApiKey() {
  const envKey = process.env.COMMAND_CODE_API_KEY || process.env.COMMANDCODE_API_KEY || process.env.CMD_API_KEY
  if (envKey && envKey.trim()) return envKey.trim()

  try {
    const authFile = join(homedir(), '.commandcode', 'auth.json')
    if (!existsSync(authFile)) return null
    const raw = JSON.parse(readFileSync(authFile, 'utf8'))
    return typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : null
  } catch {
    return null
  }
}

function getEnvironmentContext(sessionId) {
  const existing = environmentContextBySession.get(sessionId)
  if (existing) return existing

  const workingDir = process.env.CC_GO_SHIM_PROJECT_DIR || process.cwd()
  const context = {
    workingDir,
    date: new Date().toISOString().split('T')[0] || '',
    environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
    structure: directoryStructure(workingDir),
    isGitRepo: isGitRepository(workingDir),
    currentBranch: gitOutput(workingDir, ['branch', '--show-current']),
    mainBranch: mainBranch(workingDir),
    gitStatus: gitStatus(workingDir),
    recentCommits: recentCommits(workingDir),
  }
  environmentContextBySession.set(sessionId, context)
  return context
}

function projectSlug() {
  const cwd = (process.env.CC_GO_SHIM_PROJECT_DIR || process.cwd()).replace(/\\/g, '/').replace(/\/+$/, '')
  return cwd.split('/').pop() || 'commandcode-go-shim'
}

function directoryStructure(workingDir) {
  const ignored = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', 'coverage', '.cache', 'tmp', 'temp', 'out'])
  try {
    return readdirSync(workingDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.'))
      .filter(entry => !ignored.has(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function isGitRepository(workingDir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: workingDir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function mainBranch(workingDir) {
  const branches = gitOutput(workingDir, ['branch', '-r'])
  if (branches.includes('origin/main')) return 'main'
  if (branches.includes('origin/master')) return 'master'
  return branches ? 'main' : ''
}

function gitStatus(workingDir) {
  const status = gitOutput(workingDir, ['status', '--porcelain'])
  if (!status) return 'Working tree clean'
  return status.split('\n').slice(0, 20)
}

function recentCommits(workingDir) {
  const commits = gitOutput(workingDir, ['log', '--oneline', '-3'])
  return commits ? commits.split('\n') : []
}

function gitOutput(workingDir, args) {
  try {
    return execFileSync('git', args, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

async function streamOpenAIResponse(res, body, model) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const completionId = `chatcmpl-${randomUUID()}`
  let toolIndex = 0
  let sawToolCall = false
  let usage = null

  res.write(sseData({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  }))

  for await (const event of readAlphaEvents(body)) {
    const type = firstString(event.type, event.event)
    if (!type) continue

    if (type === 'text-delta' || type === 'text_delta' || type === 'output_text_delta') {
      const text = firstText(event.text, event.delta, event.content)
      if (!text) continue
      res.write(sseData({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }))
      continue
    }

    if (type === 'tool-call' || type === 'tool_call') {
      sawToolCall = true
      const id = firstString(event.toolCallId, event.tool_call_id, event.id) || `call_${randomUUID()}`
      const name = firstString(event.toolName, event.tool_name, event.name) || 'tool'
      const input = alphaToolInput(event)
      res.write(sseData({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolIndex,
              id,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(input),
              },
            }],
          },
          finish_reason: null,
        }],
      }))
      toolIndex += 1
      continue
    }

    if (type === 'finish' || type === 'done' || type === 'message_stop') {
      usage = usageFromEvent(event)
      res.write(sseData({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : 'stop' }],
        ...(usage ? { usage } : {}),
      }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
  }

  res.write(sseData({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : 'stop' }],
    ...(usage ? { usage } : {}),
  }))
  res.write('data: [DONE]\n\n')
  res.end()
}

async function collectOpenAIResponse(body, model) {
  const completionId = `chatcmpl-${randomUUID()}`
  let text = ''
  const toolCalls = []
  let usage = null

  for await (const event of readAlphaEvents(body)) {
    const type = firstString(event.type, event.event)
    if (!type) continue

    if (type === 'text-delta' || type === 'text_delta' || type === 'output_text_delta') {
      const delta = firstText(event.text, event.delta, event.content)
      if (delta) text += delta
      continue
    }

    if (type === 'tool-call' || type === 'tool_call') {
      toolCalls.push({
        id: firstString(event.toolCallId, event.tool_call_id, event.id) || `call_${randomUUID()}`,
        type: 'function',
        function: {
          name: firstString(event.toolName, event.tool_name, event.name) || 'tool',
          arguments: JSON.stringify(alphaToolInput(event)),
        },
      })
      continue
    }

    if (type === 'finish' || type === 'done' || type === 'message_stop') {
      usage = usageFromEvent(event)
    }
  }

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls, content: text || '' } : { content: text }),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    ...(usage ? { usage } : {}),
  }
}

async function* readAlphaEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        const parsed = parseAlphaLine(line)
        if (parsed) yield parsed
      }
    }

    if (buffer.trim()) {
      const parsed = parseAlphaLine(buffer)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}

function parseAlphaLine(line) {
  let json = line.trim()
  if (!json) return null
  if (json.startsWith('data:')) json = json.slice(5).trim()
  if (!json || json === '[DONE]') return null
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function alphaToolInput(event) {
  return firstRecord(event.input, event.arguments, event.args, event.payload) || {}
}

function usageFromEvent(event) {
  const usage = firstRecord(event.totalUsage, event.total_usage, event.usage)
  if (!usage) return null
  const promptTokens = firstNumber(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens) || 0
  const completionTokens = firstNumber(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens) || 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function normalizeUpstreamError(detail) {
  if (!detail) return ''
  if (/upgrade_required|provider plan or higher|403/i.test(detail)) {
    return 'Command Code rechazó la llamada. La Provider API oficial sigue bloqueada para Go, y este shim depende de un endpoint interno que puede cambiar o ser restringido sin aviso.'
  }
  return detail.slice(0, 800)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
    if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  }
  return ''
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function firstRecord(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return null
}

function parseJsonLoose(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}
