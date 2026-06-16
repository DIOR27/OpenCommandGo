const messages = {
  en: {
    // -- Setup --
    "setup.title": "Configuring OpenCommandGo.\n",
    "setup.opencode.config": "OpenCode config: {0} -> {1}",
    "setup.opencode.desktop": "OpenCode Desktop: {0}",
    "setup.opencode.cli": "OpenCode CLI: {0}",
    "setup.api_key.prompt": "Command Code API key{0}: ",
    "setup.port.prompt": "OpenCommandGo port [{0}]: ",
    "setup.autostart.prompt": "Enable autostart on login? [Y/n]: ",
    "setup.synced": "OpenCode configured at: {0}",
    "setup.not_detected": "OpenCode not detected yet. Config saved anyway.",
    "setup.autostart.enabled": "Autostart enabled.",
    "setup.autostart.disabled": "Autostart disabled.",
    "setup.config_saved": "Config saved at: {0}",
    "setup.secrets_saved": "Secrets saved at: {0}",

    // -- Start --
    "start.refreshing": "Refreshing model catalog...",
    "start.updated": "Catalog updated.",
    "start.warning": "Warning: could not update catalog, starting anyway.",
    "start.already_running": "OpenCommandGo already running with PID {0}.",
    "start.already_running_port": "OpenCommandGo already running on http://{0}:{1}.",
    "start.launched": "OpenCommandGo launched in background with PID {0}.",
    "start.watchdog_active": "Watchdog auto-recovery active.",
    "start.port_conflict": "Port {0} is already occupied by another process or a stale shim with a different token. Stop it first and try again.",
    "start.failed": "OpenCommandGo could not start in background. Check if the port is free and try again.",

    // -- Server --
    "server.listening": "OCG listening on http://{0}:{1}",

    // -- Stop --
    "stop.no_pid": "No PID saved.",
    "stop.already_gone": "Process no longer existed; cleaned PID.",
    "stop.stopped": "OpenCommandGo stopped (PID {0}).",
    "stop.graceful": "Stopping OpenCommandGo (PID {0})...",
    "stop.graceful_timeout": "Process did not exit gracefully, forcing shutdown...",
    "stop.found_by_port": "Found process PID {0} listening on port {1}.",
    "stop.port_not_occupied": "No process found listening on port {0}.",
    "stop.killed_by_port": "Stopped process on port {0} (PID {1}).",
    "stop.skipped_self": "Process PID {0} is the current process; skipping.",

    // -- Status --
    "status.shim": "Shim: {0} ({1}:{2})",
    "status.active": "active",
    "status.inactive": "inactive",
    "status.provider": "Provider: {0}",
    "status.config": "Config: {0}",
    "status.secrets": "Secrets: {0}",
    "status.opencode_config": "OpenCode config: {0}",
    "status.provider_registered": "Provider registered: {0}",
    "status.yes": "yes",
    "status.no": "no",
    "status.desktop_detected": "Desktop detected: {0}",
    "status.cli_detected": "CLI detected: {0}",
    "status.autostart_enabled": "Autostart enabled: {0}",
    "status.autostart_provider": "Autostart provider: {0}",
    "status.models_count": "Useful models in catalog: {0}",

    // -- Doctor --
    "doctor.api_key": "API key: {0}",
    "doctor.ok": "ok",
    "doctor.missing": "missing",
    "doctor.shim_health": "OpenCommandGo health: {0}",
    "doctor.up": "up",
    "doctor.down": "down",
    "doctor.connectivity": "Connectivity to {0}: {1}",
    "doctor.connectivity_ok": "ok",
    "doctor.connectivity_fail": "fail",
    "doctor.api_key_valid": "API key valid: {0}",
    "doctor.api_key_yes": "yes",
    "doctor.api_key_no": "no",
    "doctor.api_key_error": "API key check: {0}",
    "doctor.opencode_config": "OpenCode config detected: {0}",
    "doctor.provider": "Provider OCG CommandCode configured: {0}",
    "doctor.desktop": "Desktop detected: {0}",
    "doctor.cli": "CLI detected: {0}",
    "doctor.compat_matrix": "Compat matrix: {0}",
    "doctor.catalog_age": "Catalog updated: {0}",
    "doctor.autostart": "Autostart configured: {0}",
    "doctor.autostart_provider": "Autostart provider: {0}",
    "doctor.models": "Useful models in catalog: {0}",

    // -- Refresh --
    "refresh.start": "Refreshing model catalog and compatibility...",
    "refresh.catalog": "Catalog: {0}",
    "refresh.model_start": "[{0}/{1}] {2}...",
    "refresh.model_done": "  -> {0}",
    "refresh.complete": "Refresh complete. Useful models: {0}",
    "refresh.probe_warning": "Warning: verifying real availability will consume tokens/credits on Command Code.",
    "refresh.probe_confirm": "Continue with probes? [y/N]: ",

    // -- API key --
    "setapikey.prompt": "New Command Code API key{0}: ",
    "setapikey.saved": "API key updated at: {0}",

    // -- Errors --
    "error.required": "This value is required.",
    "error.missing_api_key": "Missing API key. Run: ocg setup or ocg set-api-key",
    "error.host_not_allowed": "Host not allowed for local use: {0}. Use 127.0.0.1 or localhost.",
    "error.upstream": "Command Code responded {0}: {1}",
    "error.upstream_no_body": "Command Code did not return a streaming body",
    "error.upstream_stream": "Command Code stream error: {0}",
    "error.upstream_models": "models {0}",

    // -- Help --
    "help.text": `${bold("ocg")}

Commands:
  setup
  start [--background]
  serve
  stop
  logs [--lines N] [--follow|-f]
  enable-autostart
  disable-autostart
  autostart-status
  autostart <enable|disable|status>
  status
  doctor
  refresh-models [--probe|--full] [--parallel N] [--yes]
  set-api-key
  reset
  uninstall`,

    // -- Autostart --
    "autostart.enabled": "Autostart enabled.",
    "autostart.disabled": "Autostart disabled.",
    "autostart.provider": "Provider: {0}",
    "autostart.command": "Command: ocg start --background",
    "autostart.status": "Autostart: {0}",
    "autostart.enabled_label": "enabled",
    "autostart.disabled_label": "disabled",
    "autostart.status_provider": "Provider: {0}",
    "autostart.mode": "Mode: {0}",
    "autostart.command_line": "Command: {0}",
    "autostart.sync_yes": "Config synced: {0}",
    "autostart.sync_no": "Config synced: {0}",
    "autostart.usage": "Usage: ocg autostart <enable|disable|status>",

    // -- Uninstall --
    "reset.nothing": "Config and secrets already at defaults. Nothing to reset.",
    "reset.done": "OpenCommandGo config reset:",
    "reset.deleted": "Deleted: {0}",
    "reset.regenerate": "Run 'ocg setup' to regenerate config, or 'ocg start --background' to start with defaults.",

    "uninstall.provider_removed": "Provider in OpenCode: removed",
    "uninstall.provider_not_found": "Provider in OpenCode: not configured",
    "uninstall.data_deleted": "Local data deleted: {0}",
    "uninstall.done": "OpenCommandGo uninstall complete.",

    // -- Autostart (launcher resolution) --
    "autostart.no_resolve": "Could not find the CLI executable to register autostart. Install ocg globally first.",

    // -- Misc --
    "misc.enter_keep": " (Enter to keep current)",
    "misc.unknown": "unknown",
    "misc.no": "no",

    // -- Logs --
    "logs.no_file": "No log file found at: {0}.",
    "logs.header": "Log: {0}",
    "logs.watchdog_header": "Watchdog log: {0}",
    "logs.lines": "Last {0} lines:",
    "logs.following": "Following (Ctrl+C to stop)...",
    "logs.usage": "Usage: ocg logs [--lines N] [--follow|-f] [--watchdog]",
  },

  es: {
    // -- Setup --
    "setup.title": "Configurando OpenCommandGo.\n",
    "setup.opencode.config": "OpenCode config: {0} -> {1}",
    "setup.opencode.desktop": "OpenCode Desktop: {0}",
    "setup.opencode.cli": "OpenCode CLI: {0}",
    "setup.api_key.prompt": "API key de Command Code{0}: ",
    "setup.port.prompt": "Puerto de OpenCommandGo [{0}]: ",
    "setup.autostart.prompt": "¿Desea habilitar inicio automático al iniciar sesión? [Y/n]: ",
    "setup.synced": "OpenCode quedó configurado en: {0}",
    "setup.not_detected": "OpenCode no está detectado todavía. Guardé la config de OpenCommandGo igual.",
    "setup.autostart.enabled": "Inicio automático habilitado.",
    "setup.autostart.disabled": "Inicio automático deshabilitado.",
    "setup.config_saved": "Config guardada en: {0}",
    "setup.secrets_saved": "Secretos guardados en: {0}",

    // -- Start --
    "start.refreshing": "Refrescando catálogo de modelos...",
    "start.updated": "Catálogo actualizado.",
    "start.warning": "Advertencia: no se pudo actualizar el catálogo, iniciando de todos modos.",
    "start.already_running": "OpenCommandGo ya está corriendo con PID {0}.",
    "start.already_running_port": "OpenCommandGo ya está corriendo en http://{0}:{1}.",
    "start.launched": "OpenCommandGo lanzado en background con PID {0}.",
    "start.watchdog_active": "Watchdog de auto-recuperación activo.",
    "start.port_conflict": "El puerto {0} ya está ocupado por otro proceso o por un shim viejo con token distinto. Primero detenelo y volvé a intentar.",
    "start.failed": "OpenCommandGo no pudo iniciar en background. Revisá si el puerto está libre y volvé a intentar.",

    // -- Server --
    "server.listening": "OCG escuchando en http://{0}:{1}",

    // -- Stop --
    "stop.no_pid": "No hay PID guardado.",
    "stop.already_gone": "El proceso ya no existía; limpié el PID.",
    "stop.stopped": "OpenCommandGo detenido (PID {0}).",
    "stop.graceful": "Deteniendo OpenCommandGo (PID {0})...",
    "stop.graceful_timeout": "El proceso no cerró gracefulmente, forzando cierre...",
    "stop.found_by_port": "Proceso encontrado PID {0} escuchando en puerto {1}.",
    "stop.port_not_occupied": "No hay proceso escuchando en el puerto {0}.",
    "stop.killed_by_port": "Proceso en puerto {0} (PID {1}) detenido.",
    "stop.skipped_self": "El proceso PID {0} es el proceso actual; omitiendo.",

    // -- Status --
    "status.shim": "Shim: {0} ({1}:{2})",
    "status.active": "activo",
    "status.inactive": "inactivo",
    "status.provider": "Provider: {0}",
    "status.config": "Config: {0}",
    "status.secrets": "Secretos: {0}",
    "status.opencode_config": "OpenCode config: {0}",
    "status.provider_registered": "Provider registrado: {0}",
    "status.yes": "sí",
    "status.no": "no",
    "status.desktop_detected": "Desktop detectado: {0}",
    "status.cli_detected": "CLI detectado: {0}",
    "status.autostart_enabled": "Autostart habilitado: {0}",
    "status.autostart_provider": "Autostart proveedor: {0}",
    "status.models_count": "Modelos disponibles en catálogo: {0}",

    // -- Doctor --
    "doctor.api_key": "API key: {0}",
    "doctor.ok": "ok",
    "doctor.missing": "faltante",
    "doctor.shim_health": "OpenCommandGo health: {0}",
    "doctor.up": "ok",
    "doctor.down": "caído",
    "doctor.connectivity": "Conectividad a {0}: {1}",
    "doctor.connectivity_ok": "ok",
    "doctor.connectivity_fail": "falla",
    "doctor.api_key_valid": "API key válida: {0}",
    "doctor.api_key_yes": "sí",
    "doctor.api_key_no": "no",
    "doctor.api_key_error": "API key check: {0}",
    "doctor.opencode_config": "OpenCode config detectada: {0}",
    "doctor.provider": "Provider OCG CommandCode configurado: {0}",
    "doctor.desktop": "Desktop detectado: {0}",
    "doctor.cli": "CLI detectado: {0}",
    "doctor.compat_matrix": "Compat matrix: {0}",
    "doctor.catalog_age": "Catálogo actualizado: {0}",
    "doctor.autostart": "Autostart configurado: {0}",
    "doctor.autostart_provider": "Autostart proveedor: {0}",
    "doctor.models": "Modelos disponibles en catálogo: {0}",

    // -- Refresh --
    "refresh.start": "Refrescando catálogo y compatibilidad de modelos...",
    "refresh.catalog": "Catálogo: {0}",
    "refresh.model_start": "[{0}/{1}] {2}...",
    "refresh.model_done": "  -> {0}",
    "refresh.complete": "Refresh completo. Modelos disponibles: {0}",
    "refresh.probe_warning": "Advertencia: verificar disponibilidad real consumirá tokens/créditos de su suscripción Go en Command Code.",
    "refresh.probe_confirm": "¿Desea continuar con los probes? [y/N]: ",

    // -- API key --
    "setapikey.prompt": "Nueva API key de Command Code{0}: ",
    "setapikey.saved": "API key actualizada en: {0}",

    // -- Errors --
    "error.required": "Ese valor es obligatorio.",
    "error.missing_api_key": "Falta API key. Ejecute: ocg setup o ocg set-api-key",
    "error.host_not_allowed": "Host no permitido para uso local: {0}. Utilice 127.0.0.1 o localhost.",
    "error.upstream": "Command Code respondió {0}: {1}",
    "error.upstream_no_body": "Command Code no devolvió body de streaming",
    "error.upstream_stream": "Error en stream de Command Code: {0}",
    "error.upstream_models": "models {0}",

    // -- Help --
    "help.text": `${bold("ocg")}

Comandos:
  setup
  start [--background]
  serve
  stop
  logs [--lines N] [--follow|-f]
  enable-autostart
  disable-autostart
  autostart-status
  autostart <enable|disable|status>
  status
  doctor
  refresh-models [--probe|--full] [--parallel N] [--yes]
  set-api-key
  reset
  uninstall`,

    // -- Autostart --
    "autostart.enabled": "Inicio automático habilitado.",
    "autostart.disabled": "Inicio automático deshabilitado.",
    "autostart.provider": "Proveedor: {0}",
    "autostart.command": "Comando: ocg start --background",
    "autostart.status": "Autostart: {0}",
    "autostart.enabled_label": "habilitado",
    "autostart.disabled_label": "deshabilitado",
    "autostart.status_provider": "Proveedor: {0}",
    "autostart.mode": "Modo: {0}",
    "autostart.command_line": "Comando: {0}",
    "autostart.sync_yes": "Config sincronizada: {0}",
    "autostart.sync_no": "Config sincronizada: {0}",
    "autostart.usage": "Uso: ocg autostart <enable|disable|status>",

    // -- Uninstall --
    "reset.nothing": "La config y secrets ya están en valores por defecto. Nada que resetear.",
    "reset.done": "OpenCommandGo config reseteada:",
    "reset.deleted": "Borrado: {0}",
    "reset.regenerate": "Ejecutá 'ocg setup' para regenerar la config, o 'ocg start --background' para arrancar con valores por defecto.",

    "uninstall.provider_removed": "Provider en OpenCode: removido",
    "uninstall.provider_not_found": "Provider en OpenCode: no estaba configurado",
    "uninstall.data_deleted": "Datos locales borrados: {0}",
    "uninstall.done": "Desinstalación de OpenCommandGo terminada.",

    // -- Autostart (launcher resolution) --
    "autostart.no_resolve": "No pude encontrar el ejecutable del CLI para registrar autostart. Instalá ocg globalmente primero.",

    // -- Misc --
    "misc.enter_keep": " (Enter para conservar la actual)",
    "misc.unknown": "desconocido",
    "misc.no": "no",

    // -- Logs --
    "logs.no_file": "No se encontró archivo de log en: {0}.",
    "logs.header": "Log: {0}",
    "logs.watchdog_header": "Watchdog log: {0}",
    "logs.lines": "Últimas {0} líneas:",
    "logs.following": "Siguiendo (Ctrl+C para detener)...",
    "logs.usage": "Uso: ocg logs [--lines N] [--follow|-f] [--watchdog]",
  },
}

import { colorizeStatus, bold } from "./color.js"

function detectLocale() {
  try {
    const raw = Intl.DateTimeFormat().resolvedOptions().locale || "en-US"
    return raw.startsWith("es") ? "es" : "en"
  } catch {
    return "en"
  }
}

const currentLocale = detectLocale()

export function t(key, ...args) {
  let str = messages[currentLocale]?.[key]
  if (str === undefined) str = messages.en[key]
  if (str === undefined) return key
  if (args.length > 0) {
    for (const arg of args) {
      // Colorize replacement args that are single-word status values
      const colored = colorizeStatus(String(arg ?? ""))
      str = str.replace(/\{(\d+)\}/, colored)
    }
  }
  return str
}

export function getLocale() {
  return currentLocale
}
