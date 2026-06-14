# commandcode-go-around

Public CLI to use Command Code Go models from OpenCode via a local OpenAI-compatible shim.

Main short binary:

- `ccga`

## What it does

- Launches a local shim on `127.0.0.1`
- Synchronizes a custom provider in OpenCode
- Maintains a dynamic catalog of useful models
- Protects the shim with an internal local token
- Includes setup, diagnostics, refresh, and runtime control commands

## Installation

```powershell
npm install -g .
```

## First use

```powershell
ccga setup
ccga start --background
```

## Commands

```powershell
ccga setup
ccga start
ccga start --background
ccga serve
ccga stop
ccga autostart enable
ccga autostart disable
ccga autostart status
ccga status
ccga doctor
ccga refresh-models
ccga set-api-key
ccga open-path "C:\\path\\to\\folder"
ccga open-with desktop "C:\\path\\to\\folder"
ccga open-with cli "C:\\path\\to\\folder"
ccga install-shell
ccga uninstall-shell
ccga reset-shell-choice
ccga uninstall
```

Compatibility:

```powershell
ccga ...
commandcode-shim ...
commandcode-go-around ...
```

also continue working as aliases of the binary.

## Local Configuration

### Windows

- `%APPDATA%\\commandcode-go-shim\\config.json`
- `%APPDATA%\\commandcode-go-shim\\secrets.json`
- `%APPDATA%\\commandcode-go-shim\\compatibility.json`

### macOS

- `~/Library/Application Support/commandcode-go-shim/`

### Linux

- `${XDG_CONFIG_HOME:-~/.config}/commandcode-go-shim/`

## OpenCode

The setup/sync updates:

- `~/.config/opencode/opencode.json`

Provider:

- `cmdshim`

Base URL:

- `http://127.0.0.1:4310/v1`

The shim also writes an internal header so that OpenCode is the only valid client of the local provider.

## Autostart

You can register the shim to start automatically for your user session:

```powershell
ccga autostart enable
ccga autostart status
ccga autostart disable
```

Platform provider used by the CLI:

- Windows: Startup folder (`shell:startup`)
- macOS: LaunchAgent
- Linux: user systemd service, with XDG autostart fallback

## Models

The catalog is not static.

The runtime:

- Queries `https://api.commandcode.ai/provider/v1/models`
- Filters compatible candidates
- Tests compatibility conservatively
- Avoids pruning the catalog due to transient quota/credit errors
- Resynchronizes visible models in OpenCode

To force an update:

```powershell
ccga refresh-models
```

## Security

- Local loopback by default (`127.0.0.1`)
- Mandatory internal token between OpenCode and the shim
- No open CORS
- Upstream timeout
- Stricter body limit

## Current Limitations

- Windows shell integration is included as a command, but may require additional iteration depending on the Explorer version
- Thinking/reasoning levels per model are not made up; they will only be exposed when a real mapping exists
- Depends on Command Code endpoints which may change

## Local Development

Within the project:

```powershell
npm start
```

Dry-run packaging:

```powershell
npm run pack:dry-run
```

## Publishing

The package is prepared for public publication on npm with:

- Name `commandcode-go-around`
- Main binary `commandcode-go-around`
- Alias `commandcode-shim`
- `publishConfig.access=public`

## License Note

The current `package.json` is set to `UNLICENSED`.

Before publishing definitively, change this field if you want to grant usage/redistribution permissions.
