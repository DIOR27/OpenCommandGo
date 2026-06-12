# Command Code Go Shim

Shim local OpenAI-compatible para usar modelos de Command Code Go desde OpenCode.

## Estado actual

Ahora ya tiene una base de **CLI instalable por npm** y una arquitectura pensada como:

- **core multiplataforma**
  - setup
  - config/secrets de usuario
  - runtime del shim
  - integración con OpenCode
  - doctor/status
- **adaptador Windows**
  - menú contextual `Abrir con OpenCode`
  - submenú `OpenCode Desktop` / `OpenCode CLI`

Además, el shim ahora apunta a mantener una **lista viva de modelos disponibles**:

- consulta `https://api.commandcode.ai/provider/v1/models`
- filtra candidatos compatibles con `alpha/generate`
- revalida acceso/capabilities
- sincroniza la lista útil en OpenCode

## Asset del ícono

El PNG que dejaste para integración futura quedó reubicado en:

- `C:\Users\diego\OneDrive\Documentos\commandcode-go-shim\assets\windows\opencode.png`

Para el menú contextual actual de Windows se usa directamente el ícono del ejecutable real de OpenCode cuando está disponible.

## Instalación local/global

Desde la carpeta del proyecto:

```powershell
npm install -g .
```

Después:

```powershell
commandcode-shim setup
```

## Comandos

```powershell
commandcode-shim setup
commandcode-shim start
commandcode-shim start --background
commandcode-shim stop
commandcode-shim open-path "C:\\ruta\\a\\carpeta"
commandcode-shim open-with desktop "C:\\ruta\\a\\carpeta"
commandcode-shim open-with cli "C:\\ruta\\a\\carpeta"
commandcode-shim install-shell
commandcode-shim uninstall-shell
commandcode-shim status
commandcode-shim doctor
commandcode-shim set-api-key
commandcode-shim reset-shell-choice
commandcode-shim uninstall
```

## Desarrollo

También podés seguir usando:

```powershell
npm start
```

Eso ejecuta el runtime del shim directamente.

## Configuración

### Config de usuario

En Windows:

- `C:\Users\<tu-usuario>\AppData\Roaming\commandcode-go-shim\config.json`
- `C:\Users\<tu-usuario>\AppData\Roaming\commandcode-go-shim\secrets.json`

En otros sistemas:

- macOS: `~/Library/Application Support/commandcode-go-shim/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/commandcode-go-shim/`

### Legacy dev config

Por compatibilidad, si existe:

- `C:\Users\diego\OneDrive\Documentos\commandcode-go-shim\.env.local`

el runtime todavía puede leerlo como fallback.

## OpenCode

El setup intenta actualizar automáticamente:

- `C:\Users\diego\.config\opencode\opencode.json`

El provider configurado es:

- `cmdshim`

Y apunta a:

- `http://127.0.0.1:4310/v1`

## Modelos dinámicos

La lista visible ya no depende solo del catálogo hardcodeado.

El runtime:

- descubre modelos desde Command Code
- prueba cuáles realmente responden para este acceso
- excluye modelos `broken`
- actualiza el provider `cmdshim` en OpenCode con la lista vigente

Esto está pensado específicamente para que el set de modelos del plan Go/$1 no quede congelado.

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

## Limitaciones actuales

- la integración de shell de Windows ya usa submenú, pero sigue siendo una primera versión
- `reset-shell-choice` quedó solo por compatibilidad y ya no hace nada relevante
- Desktop se lanza pasando la carpeta como argumento; si OpenCode cambia ese contrato habrá que ajustarlo
- depende de endpoints internos/no documentados de Command Code
