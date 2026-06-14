import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ensureDir } from "../config/paths.js"

export function writeTextFile(file, content) {
  ensureDir(dirname(file))
  writeFileSync(file, content, "utf8")
}

export function removeFileIfExists(file) {
  if (existsSync(file)) unlinkSync(file)
}
