import { renameSync, statSync, unlinkSync } from "node:fs"

const MAX_LOG_BYTES = 5 * 1024 * 1024  // 5 MB
const MAX_LOG_FILES = 5                // keep .1 through .4

/**
 * Rotate a log file if it exceeds MAX_LOG_BYTES.
 *
 * Works like standard logrotate: shim.log → shim.log.1 → .2 → .3 → .4,
 * oldest (.5) is deleted. All filesystem operations are wrapped in
 * try/catch so rotation never throws.
 */
export function rotateLogIfNeeded(logFile) {
  try {
    const stats = statSync(logFile)
    if (stats.size < MAX_LOG_BYTES) return
  } catch {
    // File doesn't exist yet
    return
  }

  // Shift old logs: .4 → delete, .3 → .4, .2 → .3, .1 → .2
  try { unlinkSync(`${logFile}.${MAX_LOG_FILES - 1}`) } catch {}
  for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
    try {
      renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`)
    } catch {}
  }
  renameSync(logFile, `${logFile}.1`)
}
