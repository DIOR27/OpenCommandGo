import { spawn } from "node:child_process"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { getPaths, ensureDir } from "../config/paths.js"

const USAGE_REFRESH_MS = 5 * 60 * 1000

let cached = null
let lastFetch = 0
let inFlight = null

export function getCachedUsage() {
  return cached
}

export function isUsageFresh() {
  return cached && Date.now() - lastFetch < USAGE_REFRESH_MS
}

export async function fetchCommandCodeUsage() {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const raw = await runCmdUsage()
      const parsed = parseUsage(raw)
      if (parsed) {
        cached = parsed
        lastFetch = Date.now()
        persistUsage(parsed)
      }
      return parsed
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function runCmdUsage() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn("script", ["-qec", "cmd /usage", "/dev/null"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch {
      resolve("")
      return
    }

    let buf = ""
    const onData = (d) => {
      buf += d.toString("utf8")
      // Stop once the real data has loaded (passes "Loading…")
      if (buf.includes("Cycle:") && buf.includes("renewal")) {
        child.kill("SIGKILL")
        resolve(buf)
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)

    // Safety timeout: kill and resolve with whatever we have
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(buf)
    }, 15000)

    child.on("error", () => {
      clearTimeout(timer)
      resolve(buf)
    })
    child.on("close", () => {
      clearTimeout(timer)
      resolve(buf)
    })
  })
}

export function parseUsage(raw) {
  if (!raw || typeof raw !== "string") return null
  const text = stripAnsi(raw)

  const cycle = text.match(/Cycle:\s*\$([\d.]+)\s*left/)
  const reqs = text.match(/·\s*([\d,]+)\s*requests/)
  const days = text.match(/(\d+)\s*days?\s*to\s*renewal/)
  const used = text.match(/(\d+)%\s*used/)
  const fiveHour = text.match(/5-hour\s*[█░]+\s*(\d+)%/)
  const weekly = text.match(/Weekly\s*[█░]+\s*(\d+)%/)
  const plan = text.match(/USAGE\s+([A-Za-z][\w\s]*?)\s*·/)

  if (!cycle) return null

  return {
    plan: plan ? plan[1].trim() : null,
    cycleLeft: Number(cycle[1]),
    requestsLeft: reqs ? Number(reqs[1].replace(/,/g, "")) : null,
    daysToRenewal: days ? Number(days[1]) : null,
    usedPercent: used ? Number(used[1]) : null,
    fiveHourPercent: fiveHour ? Number(fiveHour[1]) : null,
    weeklyPercent: weekly ? Number(weekly[1]) : null,
    fetchedAt: new Date().toISOString(),
  }
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/⌘/g, "")
}

function persistUsage(parsed) {
  try {
    const paths = getPaths()
    ensureDir(paths.dataDir)
    const file = join(paths.dataDir, "usage.json")
    writeFileSync(file, JSON.stringify(parsed, null, 2), "utf8")
  } catch {
    // Non-critical: in-memory cache is enough
  }
}

export function formatUsageLine(u) {
  if (!u) return null
  const parts = []
  if (u.plan) parts.push(u.plan)
  if (u.cycleLeft !== null && u.cycleLeft !== undefined) parts.push(`$${u.cycleLeft.toFixed(2)} left`)
  if (u.requestsLeft !== null && u.requestsLeft !== undefined) parts.push(`${u.requestsLeft} reqs`)
  if (u.daysToRenewal !== null && u.daysToRenewal !== undefined) parts.push(`${u.daysToRenewal}d`)
  if (u.weeklyPercent !== null && u.weeklyPercent !== undefined) parts.push(`weekly ${u.weeklyPercent}%`)
  if (u.fiveHourPercent !== null && u.fiveHourPercent !== undefined) parts.push(`5h ${u.fiveHourPercent}%`)
  return parts.length > 0 ? parts.join(" · ") : null
}
