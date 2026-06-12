# commandcode-go-around

CLI pública para usar modelos de Command Code Go desde OpenCode a través de un shim local OpenAI-compatible.

Binario corto principal:

- `ccga`

## Qué hace

- levanta un shim local en `127.0.0.1`
- sincroniza un provider custom en OpenCode
- mantiene catálogo dinámico de modelos útiles
- protege el shim con token interno local
- incluye comandos de setup, diagnóstico, refresh y control del runtime

## Instalación

```powershell
npm install -g .
```

## Primer uso

```powershell
ccga setup
ccga start --background
```

## Comandos

```powershell
ccga setup
ccga start
ccga start --background
ccga serve
ccga stop
ccga status
ccga doctor
ccga refresh-models
ccga set-api-key
ccga open-path "C:\\ruta\\a\\carpeta"
ccga open-with desktop "C:\\ruta\\a\\carpeta"
ccga open-with cli "C:\\ruta\\a\\carpeta"
ccga install-shell
ccga uninstall-shell
ccga reset-shell-choice
ccga uninstall
```

Compatibilidad:

```powershell
ccga ...
commandcode-shim ...
commandcode-go-around ...
```

también siguen funcionando como alias del binario.

## Configuración local

### Windows

- `%APPDATA%\\commandcode-go-shim\\config.json`
- `%APPDATA%\\commandcode-go-shim\\secrets.json`
- `%APPDATA%\\commandcode-go-shim\\compatibility.json`

### macOS

- `~/Library/Application Support/commandcode-go-shim/`

### Linux

- `${XDG_CONFIG_HOME:-~/.config}/commandcode-go-shim/`

## OpenCode

El setup/sync actualiza:

- `~/.config/opencode/opencode.json`

Provider:

- `cmdshim`

Base URL:

- `http://127.0.0.1:4310/v1`

El shim escribe también un header interno para que OpenCode sea el cliente válido del provider local.

## Modelos

El catálogo no es fijo.

El runtime:

- consulta `https://api.commandcode.ai/provider/v1/models`
- filtra candidatos compatibles
- prueba compatibilidad de forma conservadora
- evita podar el catálogo por errores transitorios de cuota/crédito
- resincroniza los modelos visibles en OpenCode

Para forzar actualización:

```powershell
ccga refresh-models
```

## Seguridad actual

- loopback local por defecto (`127.0.0.1`)
- token interno obligatorio entre OpenCode y el shim
- sin CORS abierto
- timeout upstream
- límite de body más estricto

## Limitaciones actuales

- la integración de shell de Windows está incluida como comando, pero puede requerir iteración adicional según versión de Explorer
- los niveles de thinking/reasoning por modelo no se inventan; solo se expondrán cuando exista mapeo real
- depende de endpoints de Command Code que pueden cambiar

## Desarrollo local

Dentro del proyecto:

```powershell
npm start
```

Empaquetado de prueba:

```powershell
npm run pack:dry-run
```

## Publicación

El paquete está preparado para publicación pública en npm con:

- nombre `commandcode-go-around`
- binario principal `commandcode-go-around`
- alias `commandcode-shim`
- `publishConfig.access=public`

## Nota de licencia

El `package.json` actual está en `UNLICENSED`.

Antes de publicar de forma definitiva, cambiá ese campo si querés otorgar permisos de uso/redistribución.
