#!/usr/bin/env node

import { runCli } from "./src/cli/main.js"

const args = process.argv.slice(2)

const flags = {
  start:        args.includes("--start") || args.includes("--serve"),
  background:   args.includes("--background"),
  stop:         args.includes("--stop") || args.includes("--shutdown"),
  status:       args.includes("--status"),
  doctor:       args.includes("--doctor"),
  logs:         args.includes("--logs") || args.includes("--log"),
  refresh:      args.includes("--refresh-models") || args.includes("--refresh"),
  setup:        args.includes("--setup"),
  setApiKey:    args.includes("--set-api-key"),
  reset:        args.includes("--reset"),
  uninstall:    args.includes("--uninstall"),
  help:         args.includes("--help") || args.includes("-h"),
  // refresh flags
  full:         args.includes("--full"),
  probe:        args.includes("--probe") || args.includes("--verify"),
  yes:          args.includes("--yes"),
  showModels:   args.includes("--show-models"),
  // log flags
  watchdog:     args.includes("--watchdog"),
  follow:       args.includes("-f") || args.includes("--follow"),
}

// Extract --lines=N or -n N
let lines = undefined
for (let i = 0; i < args.length; i++) {
  const match = args[i]?.match(/^--lines=(\d+)$/)
  if (match) { lines = Number(match[1]); break }
  if ((args[i] === "-n" || args[i] === "--lines") && i + 1 < args.length) {
    lines = Number(args[i + 1]); break
  }
}

// Build rest args for delegation
function buildRest(excludeFlags) {
  return args.filter(a => !excludeFlags.includes(a))
}

// Map flags to subcommand
if (flags.help) {
  await runCli(["help"])
} else if (flags.setup) {
  await runCli(["setup"])
} else if (flags.setApiKey) {
  await runCli(["set-api-key"])
} else if (flags.stop) {
  await runCli(["stop"])
} else if (flags.status) {
  await runCli(["status"])
} else if (flags.doctor) {
  await runCli(["doctor"])
} else if (flags.logs) {
  const logArgs = [...buildRest(["--logs", "--log", "--watchdog", "-f", "--follow"])]
  if (flags.watchdog) logArgs.push("--watchdog")
  if (flags.follow) logArgs.push("--follow")
  if (lines !== undefined) logArgs.push("--lines", String(lines))
  await runCli(["logs", ...logArgs])
} else if (flags.refresh) {
  const refreshArgs = [...buildRest(["--refresh-models", "--refresh", "--full", "--probe", "--verify", "--yes", "--show-models"])]
  if (flags.full) refreshArgs.push("--full")
  if (flags.probe) refreshArgs.push("--probe")
  if (flags.yes) refreshArgs.push("--yes")
  if (flags.showModels) refreshArgs.push("--show-models")
  await runCli(["refresh-models", ...refreshArgs])
} else if (flags.reset) {
  await runCli(["reset"])
} else if (flags.uninstall) {
  await runCli(["uninstall"])
} else {
  // Default: start (foreground). --background goes through as rest arg.
  const startArgs = buildRest(["--start", "--serve", "--background"])
  if (flags.background) startArgs.push("--background")
  await runCli(["start", ...startArgs])
}
