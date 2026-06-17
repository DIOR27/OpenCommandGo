# Next session handoff

## Done

- Project renamed and normalized around `ocg` / OpenCommandGo clean install.
- Provider label in OpenCode is `OCG CommandCode`.
- Model refresh supports catalog-only sync, `--probe`, `--full`, `--parallel`, and confirmation gating for token-spending probes.
- Runtime exposes watchdog-assisted background start, `/shutdown`, log files, and reset flow.
- Real isolated integration tests cover:
  - `ocg start --background`
  - duplicate-start protection
  - `ocg stop`
  - `ocg logs` + `--watchdog` + basic `--follow`
  - watchdog crash recovery
  - `/v1/chat/completions` non-stream, errors, tool calls, multimodal image inputs, and SSE streaming
- First refactor batch extracted chat bridge and HTTP utilities out of `server.js`.

## Verified current state

- Public runtime facade remains in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\server.js`
- Extracted chat bridge lives in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\chat-bridge.js`
- Extracted HTTP/shim helpers live in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\http-utils.js`
- CLI and watchdog remain in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\cli\main.js`
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\watchdog\index.js`
- Integration harness lives in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\test\cli-integration.test.js`

## Still missing / next phase

1. Second refactor batch: extract catalog/probe orchestration from `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\server.js`.
2. Stronger verification around OpenCode capability badges versus what upstream Command Code exposes.
3. Decide whether watchdog timing env overrides stay as internal/test-only behavior or should be documented explicitly.
4. Optional extra bridge tests for stream error behavior and richer tool-result/reasoning roundtrips.

## Important constraints

- Do not add migration logic; keep installation clean.
- Do not run build steps after changes.
- Do not add markdown planning docs to the repo unless the user explicitly asks again.
- Probe/full model verification spends Command Code Go credits/tokens by design.
