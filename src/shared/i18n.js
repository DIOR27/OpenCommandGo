const messages = {
  en: {
    // -- Setup --
    "setup.title": "Configuring OpenCommandGo.\n",
    "setup.opencode.config": "OpenCode config: {0} -> {1}",
    "setup.opencode.desktop": "OpenCode Desktop: {0}",
    "setup.opencode.cli": "OpenCode CLI: {0}",
    "setup.api_key.prompt": "Command Code API key{0}: ",
    "setup.port.prompt": "OpenCommandGo port [{0}]: ",

    "setup.synced": "OpenCode configured at: {0}",
    "setup.not_detected": "OpenCode not detected yet. Config saved anyway.",

    "setup.config_saved": "Config saved at: {0}",
    "setup.secrets_saved": "Secrets saved at: {0}",

    // -- Start --
    "start.refreshing": "Refreshing model catalog...",
    "start.updated": "Catalog updated.",
    "start.warning": "Warning: could not update catalog, starting anyway.",
    "start.free_models_header": "Free models right now:",
    "start.free_model_item": "  • {0} ({1})",
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

    "doctor.watchdog": "Watchdog: {0}",
    "doctor.watchdog_active": "active",
    "doctor.watchdog_inactive": "inactive",
    "doctor.watchdog_restarts": "({0} restarts)",
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
    "error.missing_api_key": "Missing API key. Run: node shim.js --setup",
    "error.host_not_allowed": "Host not allowed for local use: {0}. Use 127.0.0.1 or localhost.",
    "error.upstream": "Command Code responded {0}: {1}",
    "error.upstream_no_body": "Command Code did not return a streaming body",
    "error.upstream_stream": "Command Code stream error: {0}",
    "error.upstream_models": "models {0}",

    // -- Help --
    "help.text": `${bold("shim.js")}

Flags:
  --start                 Start server (default action)
  --background            Start in background
  --stop, --shutdown      Stop server
  --status                Show status
  --doctor                Run diagnostics
  --logs, --log           Show logs (add --follow, --watchdog, --lines N)
  --refresh-models        Refresh catalog
    --full                  Full probe (tests each model)
    --probe, --verify       Fast probe
    --yes                   Skip confirmation
    --show-models           List models after refresh
  --setup                 Interactive setup
  --set-api-key           Update API key
  --reset                 Reset config
  --uninstall             Remove all data
  --help, -h              Show this help`,

    // -- Uninstall --
    "reset.nothing": "Config and secrets already at defaults. Nothing to reset.",
    "reset.done": "OpenCommandGo config reset:",
    "reset.deleted": "Deleted: {0}",
    "reset.regenerate": "Run 'node shim.js --setup' to regenerate config, or 'node shim.js' to start with defaults.",

    "uninstall.provider_removed": "Provider in OpenCode: removed",
    "uninstall.provider_not_found": "Provider in OpenCode: not configured",
    "uninstall.data_deleted": "Local data deleted: {0}",
    "uninstall.done": "OpenCommandGo uninstall complete.",

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
    "logs.usage": "Usage: node shim.js --logs [--lines N] [--follow|-f] [--watchdog]",
  },

  es: {
    // -- Setup --
    "setup.title": "Configurando OpenCommandGo.\n",
    "setup.opencode.config": "OpenCode config: {0} -> {1}",
    "setup.opencode.desktop": "OpenCode Desktop: {0}",
    "setup.opencode.cli": "OpenCode CLI: {0}",
    "setup.api_key.prompt": "API key de Command Code{0}: ",
    "setup.port.prompt": "Puerto de OpenCommandGo [{0}]: ",
    "setup.synced": "OpenCode quedó configurado en: {0}",
    "setup.not_detected": "OpenCode no está detectado todavía. Guardé la config de OpenCommandGo igual.",
    "setup.config_saved": "Config guardada en: {0}",
    "setup.secrets_saved": "Secretos guardados en: {0}",

    // -- Start --
    "start.refreshing": "Refrescando catálogo de modelos...",
    "start.updated": "Catálogo actualizado.",
    "start.warning": "Advertencia: no se pudo actualizar el catálogo, iniciando de todos modos.",
    "start.free_models_header": "Modelos gratis en este momento:",
    "start.free_model_item": "  • {0} ({1})",
    "start.already_running": "OpenCommandGo ya está corriendo con PID {0}.",
    "start.already_running_port": "OpenCommandGo ya está corriendo en http://{0}:{1}.",
    "start.launched": "OpenCommandGo lanzado en background con PID {0}.",
    "start.watchdog_active": "Watchdog de auto-recuperación activo.",
    "start.port_conflict": "El puerto {0} ya está ocupado por otro proceso o por un shim viejo con token distinto. Primero deténgalo y vuelva a intentar.",
    "start.failed": "OpenCommandGo no pudo iniciar en background. Revise si el puerto está libre y vuelva a intentar.",

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

    "doctor.watchdog": "Watchdog: {0}",
    "doctor.watchdog_active": "activo",
    "doctor.watchdog_inactive": "inactivo",
    "doctor.watchdog_restarts": "({0} reinicios)",
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
    "error.missing_api_key": "Falta API key. Ejecutá: node shim.js --setup",
    "error.host_not_allowed": "Host no permitido para uso local: {0}. Utilice 127.0.0.1 o localhost.",
    "error.upstream": "Command Code respondió {0}: {1}",
    "error.upstream_no_body": "Command Code no devolvió body de streaming",
    "error.upstream_stream": "Error en stream de Command Code: {0}",
    "error.upstream_models": "models {0}",

    // -- Help --
    "help.text": `${bold("shim.js")}

Flags:
  --start                 Iniciar servidor (acción por defecto)
  --background            Iniciar en background
  --stop, --shutdown      Detener servidor
  --status                Mostrar estado
  --doctor                Diagnóstico
  --logs, --log           Mostrar logs (--follow, --watchdog, --lines N)
  --refresh-models        Refrescar catálogo
    --full                  Probe completo (cada modelo)
    --probe, --verify       Probe rápido
    --yes                   Saltar confirmación
    --show-models           Listar modelos después del refresh
  --setup                 Configuración interactiva
  --set-api-key           Cambiar API key
  --reset                 Resetear config
  --uninstall             Eliminar todos los datos
  --help, -h              Mostrar esta ayuda`,

    // -- Uninstall --
    "reset.nothing": "La config y secrets ya están en valores por defecto. Nada que resetear.",
    "reset.done": "OpenCommandGo config reseteada:",
    "reset.deleted": "Borrado: {0}",
    "reset.regenerate": "Ejecutá 'node shim.js --setup' para regenerar la config, o 'node shim.js' para arrancar con valores por defecto.",

    "uninstall.provider_removed": "Provider en OpenCode: removido",
    "uninstall.provider_not_found": "Provider en OpenCode: no estaba configurado",
    "uninstall.data_deleted": "Datos locales borrados: {0}",
    "uninstall.done": "Desinstalación de OpenCommandGo terminada.",

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
    "logs.usage": "Uso: node shim.js --logs [--lines N] [--follow|-f] [--watchdog]",
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
