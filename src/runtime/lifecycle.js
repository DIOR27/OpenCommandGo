export function installProcessLifecycleHandlers({ clearPid }) {
  process.on("exit", () => clearPid())
  process.on("SIGINT", () => {
    clearPid()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    clearPid()
    process.exit(0)
  })
}
