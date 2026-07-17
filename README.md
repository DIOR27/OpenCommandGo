# OpenCommandGo

Proxy to use Command Code Go subscription models from OpenCode through a local OpenAI-compatible bridge.

## What it does

- Launches a local shim server on `127.0.0.1`
- Synchronizes the `commandcode` provider automatically in OpenCode
- Maintains a dynamic catalog of Command Code models
- Protects the shim with an internal local token
- Includes watchdog auto-recovery, diagnostics, catalog refresh, and runtime control

## Usage

```bash
node proxy.js                 # start server (foreground)
node proxy.js --background    # start with watchdog
node proxy.js --stop          # stop server
node proxy.js --status        # show status
node proxy.js --logs --follow # live log tailing
node proxy.js --doctor        # full diagnostics
node proxy.js --docs-models   # scrape Open Source model capabilities from docs and apply
node proxy.js --edit-models   # interactive TUI to toggle capabilities per model
```

### First-time setup

```bash
node proxy.js --setup
```

### Catalog refresh

```bash
node proxy.js --refresh-models              # sync catalog
node proxy.js --refresh-models --probe      # validate real availability
node proxy.js --refresh-models --full       # probe text, image, reasoning, tools
node proxy.js --refresh-models --full --yes  # skip confirmation
```

### Open Source model capabilities from docs

```bash
node proxy.js --docs-models
```

Scrapes the Command Code documentation for Open Source models and applies their documented capabilities (vision, reasoning, etc.) to `~/.config/ocg/manual-capabilities.json`, then syncs to OpenCode. The data survives catalog refreshes and is immediately visible in OpenCode (image input, reasoning badge, etc.).

All capabilities are tagged with source `manual_override` and can be verified or adjusted with `--edit-models`.

### Interactive capability editor

```bash
node proxy.js --edit-models
```

Raw-mode TUI with arrow key navigation:
- **↑↓** — navigate between models and capabilities
- **Enter** — select a model to edit, or toggle a capability on/off
- **Esc/q** — go back to model list or exit
- **▣/□** — enabled/disabled capability indicator

Overrides are persisted to `~/.config/ocg/manual-capabilities.json`, survive any catalog refresh, and are automatically synced to `opencode.json` on exit.

## Local configuration

### Windows

- `%APPDATA%\ocg\config.json`
- `%APPDATA%\ocg\secrets.json`
- `%APPDATA%\ocg\compatibility.commandcode.json`

### macOS

- `~/Library/Application Support/ocg/`

### Linux

- `${XDG_CONFIG_HOME:-~/.config}/ocg/`

Runtime data:

- `compatibility.commandcode.json` — cached model catalog
- `manual-capabilities.json` — manual capability overrides (via `--edit-models` or `--docs-models`)
- `usage.json` — cached Command Code usage/balance
- `secrets.json` — local token
- `config.json` — server configuration

## OpenCode

Setup syncs the provider to:

- `~/.config/opencode/opencode.json`

Provider IDs:

- `commandcode` (canonical)
- `ocg` (legacy alias)

Base URLs:

- `http://127.0.0.1:4310/commandcode/v1`
- `http://127.0.0.1:4310/ocg/v1` (legacy alias)

The shim writes an internal header so that only OpenCode is a valid client of the local provider.

### Cross-provider capability merge

On sync, the shim inspects existing providers in `opencode.json` and attempts to read metadata from the OpenCode Desktop sidecar. When a Command Code model matches another provider by normalized id, missing capabilities are enriched from the best match. Provenance is tagged as `cross-provider-sidecar:<providerId>` or `cross-provider-config:<providerId>` depending on the source.

## Models

The catalog is built dynamically at startup:

- Runs `cmd --list-models` as the primary source
- Falls back to `https://api.commandcode.ai/provider/v1/models`
- Filters to Open Source models (Go subscription scope)
- Infers capabilities (vision, multimodal, reasoning)
- Tests compatibility conservatively
- Avoids pruning the catalog due to transient quota errors
- Resynchronizes visible models in OpenCode

OpenCode badges are driven by:

- `modalities.input` — upstream capabilities, with fallback registry only when upstream omits the data
- `capabilities.{vision,pdf,audio,video}` — preserve the original source
- `reasoning: true` — controls the "Allows reasoning" badge
- `variants` — only when a confirmed mapping exists

### Automatic vision promotion

When an image is sent to a text-only model and the upstream accepts it (200 OK), the shim automatically promotes `vision: true` in the compatibility matrix and syncs OpenCode. Once promoted, it persists across catalog refreshes.

## Security

- Local loopback by default (`127.0.0.1`)
- Mandatory internal token between OpenCode and the shim
- No open CORS
- Upstream timeout and body size limits

## Runtime operations

- `node proxy.js --background` — refreshes catalog, starts shim, launches watchdog
- `node proxy.js --stop` — attempts `/shutdown` endpoint, falls back to PID/port kill
- `node proxy.js --logs` — reads the shim log
- `node proxy.js --logs --watchdog` — reads the watchdog log
- `node proxy.js --reset` — deletes local config and secrets

## Limitations

- OpenAI-compatible shim, not a native OpenCode plugin
- Reasoning effort levels only exposed when a confirmed mapping exists
- Catalog hints may rely on fallback metadata when Command Code omits the data
- Only text and image are normalized; other structured media is passed through generically
- Depends on upstream endpoints which may change

## Local development

```bash
node proxy.js
```

```bash
node --test
```

## License

MIT
