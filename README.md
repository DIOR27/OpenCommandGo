# OpenCommandGo

CLI shim to use Command Code models from OpenCode through a local OpenAI-compatible bridge.

**Binary:** `ocg`

**Aliases:** `opencommandgo`, `opencg`

## What it does

- Launches a local shim server on `127.0.0.1`
- Synchronizes a custom provider in OpenCode
- Maintains a dynamic catalog of available models
- Protects the shim with an internal local token
- Includes setup, diagnostics, catalog refresh, and runtime control commands

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
ocg install-shell
ocg uninstall-shell
ocg reset-shell-choice
ocg uninstall
```

## Local Configuration

### Windows

- `%APPDATA%\opencg-cli\config.json`
- `%APPDATA%\opencg-cli\secrets.json`
- `%APPDATA%\opencg-cli\compatibility.json`

### macOS

- `~/Library/Application Support/opencg-cli/`

### Linux

- `${XDG_CONFIG_HOME:-~/.config}/opencg-cli/`

## OpenCode

The setup/sync updates:

- `~/.config/opencode/opencode.json`

Provider:

- `opencg-cli`

Base URL:

- `http://127.0.0.1:4310/v1`

The shim writes an internal header so that OpenCode is the only valid client of the local provider.

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

- Queries `https://api.commandcode.ai/provider/v1/models`
- Filters compatible candidates
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
- `ocg refresh-models --parallel 6` — override the worker count

Recommended:

- **Safe/manual refresh:** `ocg refresh-models`
- **Deep audit:** `ocg refresh-models --full --parallel 2 --yes`

## Security

- Local loopback by default (`127.0.0.1`)
- Mandatory internal token between OpenCode and the shim
- No open CORS
- Upstream timeout enforcement
- Stricter body size limits

## Current Limitations

- Windows shell integration is included but may need further iteration depending on the Explorer version
- Thinking/reasoning levels per model are not synthesized; they only appear when a real mapping is available
- Depends on Command Code endpoints which may change

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
