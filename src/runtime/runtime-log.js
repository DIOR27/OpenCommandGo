import { appendFileSync } from "node:fs"
import { getPaths, ensureDir } from "../config/paths.js"
import { rotateLogIfNeeded } from "../shared/log-rotation.js"

export function runtimeLog(line) {
  const paths = getPaths()
  ensureDir(paths.logDir)
  rotateLogIfNeeded(paths.logFile)
  appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${line}\n`)
}
