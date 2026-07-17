import { appendFileSync } from "node:fs"
import { getPaths, ensureDir } from "../config/paths.js"
import { rotateLogIfNeeded } from "../shared/log-rotation.js"

const ESC = "\x1b"

let persistentStatus = ""
let hasStatus = false
const isTTY = process.stdout.isTTY
const STATUS_ICON = "\u25CF" // ●

export function setPersistentStatus(status) {
  if (!status) {
    // Clear status bar
    if (hasStatus && isTTY) {
      process.stdout.write(ESC + "[2K\r")
    }
    persistentStatus = ""
    hasStatus = false
    return
  }

  const line = statusLine(status)

  if (!persistentStatus) {
    // First time — print below current position, then move cursor back up
    persistentStatus = status
    if (isTTY) {
      process.stdout.write("\n" + line + ESC + "[1A")
      hasStatus = true
    }
    return
  }

  // Update in place — cursor should be on the status line
  persistentStatus = status
  if (isTTY) {
    process.stdout.write(ESC + "[2K\r" + line)
  }
}

export function runtimeLog(line) {
  const paths = getPaths()
  ensureDir(paths.logDir)
  rotateLogIfNeeded(paths.logFile)
  const formatted = `[${new Date().toISOString()}] ${line}`
  appendFileSync(paths.logFile, formatted + "\n")

  if (hasStatus && isTTY) {
    // Clear current status line, print log, re-print status below
    process.stdout.write(ESC + "[2K\r")                      // clear status line
    process.stdout.write(formatted + "\n")                    // write log, moves cursor down
    process.stdout.write(ESC + "[2K")                         // clear new blank line
    process.stdout.write(statusLine(persistentStatus))        // write status below
    // Cursor stays on the status line — next runtimeLog clears it again
  } else {
    process.stdout.write(formatted + "\n")
  }
}

function statusLine(status) {
  return ` ${STATUS_ICON} ${status}`
}
