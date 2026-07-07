# OpenCommandGo

CLI shim to use Command Code Go subscription models from OpenCode through a local OpenAI-compatible bridge.

**Binary:** `ocg`

**Aliases:** `opencommandgo`, `opencg`

## What it does

- Launches a local shim server on `127.0.0.1`
- Synchronizes the `commandcode` provider automatically in OpenCode
- Maintains dynamic catalogs for Command Code
- Protects the shim with an internal local token
- Includes setup, diagnostics, catalog refresh, and runtime control commands
- Includes watchdog auto-recovery, log inspection, and reset helpers

## Installation

```powershell
npm install -g .
```

## First use

```powershell
ocg setup
ocg start --background
```

## Commands

```powershell
ocg setup
ocg start
ocg start --background
ocg serve
ocg stop
ocg logs
ocg logs --watchdog
ocg logs --follow
ocg autostart enable
ocg autostart disable
ocg autostart status
ocg status
ocg doctor
ocg refresh-models
ocg refresh-models --probe
ocg refresh-models --full
ocg refresh-models --parallel 6
ocg refresh-models --full --parallel 2 --yes
ocg set-api-key
ocg uninstall
```

## Local Configuration

### Windows

- `%APPDATA%\ocg\config.json`
- `%APPDATA%\ocg\secrets.json`
- `%APPDATA%\ocg\compatibility.commandcode.json`

### macOS

- `~/Library/Application Support/ocg/`

### Linux

- `${XDG_CONFIG_HOME:-~/.config}/ocg/`

## OpenCode

The setup/sync updates:

- `~/.config/opencode/opencode.json`

Provider IDs written by the shim:

- `commandcode` (canonical)
- `ocg` (legacy compatibility alias)

Base URLs:

- `http://127.0.0.1:4310/commandcode/v1`
- `http://127.0.0.1:4310/ocg/v1` (legacy alias)

The shim writes an internal header so that OpenCode is the only valid client of the local provider.
If `~/.config/opencode/opencode.json` does not exist yet, the first sync creates it automatically.

### Cross-provider capability merge

When `syncOpenCodeConfig` writes the `commandcode` / `ocg` provider entry, it also inspects the existing `provider` map already stored in `~/.config/opencode/opencode.json`.
It now also attempts a best-effort read from the running OpenCode Desktop sidecar, using the Desktop runtime's resolved provider/model metadata first and falling back to the file-based config metadata when the sidecar is unavailable or unauthorized.
If a Command Code model matches another configured provider model by normalized full id or providerless id, missing Command Code capability hints are enriched from the best match.
Injected provenance is tagged as `cross-provider-sidecar:<providerId>` for Desktop runtime data or `cross-provider-config:<providerId>` for file-config fallback data.

Sidecar discovery details:

- Reads the newest Desktop `main.log` under `~/.config/ai.opencode.desktop/logs/**/main.log`
- Extracts the current ephemeral localhost sidecar URL from `server ready { url: ... }`
- Tries `/provider` first, then `/config/providers`
- Uses optional local auth overrides when present:
  - `OPENCODE_SIDECAR_AUTHORIZATION`
  - `OPENCODE_SIDECAR_BASIC_TOKEN`
  - `OPENCODE_SIDECAR_USERNAME` + `OPENCODE_SIDECAR_PASSWORD`

If auth cannot be discovered, the shim fails closed and keeps the existing config-only merge path.

## Autostart

Register the shim to launch automatically in your user session:

```powershell
ocg autostart enable
ocg autostart status
ocg autostart disable
```

Platform support:

- **Windows:** Startup folder (`shell:startup`)
- **macOS:** LaunchAgent
- **Linux:** User systemd service, with XDG autostart fallback

## Models

The catalog is dynamically built at runtime. Each `ocg start` refreshes the catalog automatically before launching the server.

During a refresh the CLI:

- Runs `cmd --list-models` as the primary source for model listing and capability inference
- Falls back to `https://api.commandcode.ai/provider/v1/models` if `cmd` is unavailable
- Filters to Open Source models only (Go subscription scope)
- Infers capabilities (vision, multimodal, reasoning) from model descriptions via keyword matching
- Tests compatibility conservatively
- Avoids pruning the catalog due to transient quota or credit errors
- Resynchronizes visible models in OpenCode

To force an update manually:

```powershell
ocg refresh-models
```

Available modes:

- `ocg refresh-models` — syncs the catalog without consuming credits
- `ocg refresh-models --probe` — validates real availability (may consume credits)
- `ocg refresh-models --full` — probes text, image, reasoning, and tools
- `ocg refresh-models --provider commandcode` — only refreshes Command Code
- `ocg refresh-models --parallel 6` — override the worker count
- `ocg refresh-models --probe` and `--full` WILL spend Command Code Go credits/tokens

OpenCode badges are driven by generated model metadata:

- `modalities.input` mirrors upstream per-model capability metadata first, with fallback registry hints only when upstream omits it
- `capabilities.{vision,pdf,audio,video}` preserve the upstream/fallback source instead of forcing bridge-specific `unsupported` values
- `reasoning: true` controls the "Allows reasoning" badge
- `variants` only control explicit effort levels when a confirmed mapping exists

Runtime forwarding behavior:

- Text blocks are normalized to the Command Code bridge format
- Image aliases such as `image_url` and data URLs are normalized into Command Code image blocks
- Other structured content blocks are forwarded as-is so the bridge does not erase upstream modality data before transport
- End-to-end PDF/audio/video execution still depends on Command Code accepting the original block shape sent by the caller; metadata stays truthful even when a given client payload format is not yet normalized by the shim

Recommended:

- **Safe/manual refresh:** `ocg refresh-models`
- **Deep audit:** `ocg refresh-models --full --parallel 2 --yes`

## Security

- Local loopback by default (`127.0.0.1`)
- Mandatory internal token between OpenCode and the shim
- No open CORS
- Upstream timeout enforcement
- Stricter body size limits

## Runtime Operations

- `ocg start --background` refreshes the catalog, starts the shim, and launches a watchdog daemon.
- `ocg stop` first tries the internal `/shutdown` endpoint, then falls back to PID/port-based shutdown.
- `ocg logs` reads the main shim log.
- `ocg logs --watchdog` reads the watchdog log.
- `ocg reset` deletes only local config/secrets so the installation can be reconfigured cleanly.

## QA and Release

- CI: `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\ci.yml`
- Tagged npm publish: `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\publish.yml`
- Develop → main auto-release gate: `C:\Users\diego\OneDrive\Documentos\commandcode-go-around\.github\workflows\auto-release.yml`

## Current Limitations

- OpenCommandGo is still an OpenAI-compatible shim, not a native OpenCode plugin package
- Reasoning effort levels are only exposed when a confirmed mapping exists
- Catalog capability hints may still rely on curated fallback metadata when Command Code omits them
- The shim only normalizes text and image aliases itself; non-image structured media is passed through generically and may still require client/upstream shape alignment for full runtime success
- Depends on upstream vendor endpoints which may change

## Local Development

Within the project directory:

```powershell
npm start
```

Dry-run packaging to inspect the published bundle:

```powershell
npm run pack:dry-run
```

## License

MIT
