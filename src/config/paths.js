import { existsSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..", "..")
const DATA_DIR_NAME = "ocg"

export function getProjectDir() {
  return PROJECT_DIR
}

export function getAppDataRoot() {
  if (process.env.OCG_HOME) return process.env.OCG_HOME
  if (process.env.COMMANDCODE_SHIM_HOME) return process.env.COMMANDCODE_SHIM_HOME
  if (process.platform === "win32") {
    return process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support")
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

export function getShimDataDir() {
  return join(getAppDataRoot(), DATA_DIR_NAME)
}

export function getPaths() {
  const dataDir = getShimDataDir()
  return {
    projectDir: PROJECT_DIR,
    dataDir,
    configFile: join(dataDir, "config.json"),
    secretsFile: join(dataDir, "secrets.json"),
    pidFile: join(dataDir, "shim.pid"),
    watchdogPidFile: join(dataDir, "watchdog.pid"),
    logDir: join(dataDir, "logs"),
    logFile: join(dataDir, "logs", "shim.log"),
    watchdogLogFile: join(dataDir, "logs", "watchdog.log"),
    compatibilityFile: join(dataDir, "compatibility.json"),
    legacyCompatibilityFile: join(PROJECT_DIR, "compatibility.json"),
    legacyEnvFile: join(PROJECT_DIR, ".env.local"),
    opencodeConfigFile: getOpenCodeConfigPath(),
    tmpDir: tmpdir(),
  }
}

export function getOpenCodeConfigPath() {
  if (process.platform === "win32") {
    return join(process.env.USERPROFILE || homedir(), ".config", "opencode", "opencode.json")
  }
  return join(homedir(), ".config", "opencode", "opencode.json")
}

export function ensureParentDir(file) {
  ensureDir(dirname(file))
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
