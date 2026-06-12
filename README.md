# Command Code Go Shim

Shim local OpenAI-compatible para usar modelos de Command Code Go desde OpenCode.

## Qué hace

- expone `GET /v1/models`
- expone `POST /v1/chat/completions`
- traduce requests OpenAI-compatible a `https://api.commandcode.ai/alpha/generate`
- está limitado a texto y a modelos del pool Go

## Ejecutar

```powershell
cd C:\Users\diego\OneDrive\Documentos\commandcode-go-shim
npm start
```

## Configuración

El archivo sensible es:

`C:\Users\diego\OneDrive\Documentos\commandcode-go-shim\.env.local`

Variables:

- `COMMANDCODE_API_KEY`
- `SHIM_PORT` (opcional, default `4310`)
- `SHIM_HOST` (opcional, default `127.0.0.1`)
- `COMMANDCODE_BASE_URL` (opcional)
- `COMMANDCODE_VERSION` (opcional)

## Cambiar la key

Reemplazá el valor de `COMMANDCODE_API_KEY` en:

`C:\Users\diego\OneDrive\Documentos\commandcode-go-shim\.env.local`

## Modelos

- `moonshotai/Kimi-K2.6`
- `moonshotai/Kimi-K2.5`
- `Qwen/Qwen3.7-Max`
- `Qwen/Qwen3.7-Plus`
- `Qwen/Qwen3.7-Max-Free`
- `MiniMaxAI/MiniMax-M3`
- `MiniMaxAI/MiniMax-M2.7`
- `MiniMaxAI/MiniMax-M2.5`
- `deepseek/deepseek-v4-pro`
- `deepseek/deepseek-v4-flash`
- `zai-org/GLM-5.1`
- `zai-org/GLM-5`

## Limitaciones

- no streaming todavía
- no imágenes
- no PDF
- no tools/function calling
- depende de endpoints internos/no documentados de Command Code
