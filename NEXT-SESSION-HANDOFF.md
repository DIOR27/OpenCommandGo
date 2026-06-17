# Next session handoff

## Done

- Project renamed and normalized around `ocg` / OpenCommandGo clean install.
- Provider label in OpenCode is `OCG CommandCode`.
- Model refresh supports catalog-only sync, `--probe`, `--full`, `--parallel`, and confirmation gating for token-spending probes.
- Runtime exposes watchdog-assisted background start, `/shutdown`, log files, and reset flow.
- README was aligned with the current runtime commands and release workflow files.
- Focused CLI helper tests were added for refresh parsing and watchdog restart counting.
- Real isolated integration tests now cover:
  - `ocg start --background`
  - duplicate-start protection
  - `ocg stop`
  - `ocg logs` + `--watchdog` + basic `--follow`
  - watchdog crash recovery

## Verified current state

- Main tracked behavior lives in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\cli\main.js`
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\server.js`
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\watchdog\index.js`
- Integration harness lives in:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\test\cli-integration.test.js`
- Existing workflow files:
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\ci.yml`
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\publish.yml`
  - `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\auto-release.yml`

## Still missing / next phase

1. Stronger verification around OpenCode capability badges versus what upstream Command Code exposes.
2. Cleanup/refactor of `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\src\runtime\server.js`, which still carries too many responsibilities.
3. Decide whether watchdog timing env overrides stay as internal/test-only behavior or should be documented explicitly.
4. Optionally extend integration coverage to real chat/completions behavior against a mocked `/alpha/generate` upstream.

## Important constraints

- Do not add migration logic; keep installation clean.
- Do not run build steps after changes.
- Probe/full model verification spends Command Code Go credits/tokens by design.
