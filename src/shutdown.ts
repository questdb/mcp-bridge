import type { Log } from "./types.js"

export type ShutdownDeps = {
  stopMcp: () => Promise<void>
  getStopWs: () => (() => Promise<void>) | null
  exit: (code: number) => void
  log: Log
  stepBudgetMs: number
  hardBudgetMs: number
}

export type ShutdownController = {
  shutdown: () => Promise<void>
  requestFatal: (kind: string, err: Error) => Promise<void>
}

export const createShutdownController = (
  deps: ShutdownDeps,
): ShutdownController => {
  const { stepBudgetMs, hardBudgetMs } = deps
  let shuttingDown = false
  let exitCode = 0

  const withTimeout = (p: Promise<unknown>, ms: number): Promise<unknown> =>
    Promise.race([
      p.catch(() => undefined),
      new Promise<void>((res) => setTimeout(res, ms).unref()),
    ])

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    const safety = setTimeout(() => deps.exit(1), hardBudgetMs)
    safety.unref()
    try {
      await withTimeout(deps.stopMcp(), stepBudgetMs)
    } catch (err) {
      void err
    }
    const stopWs = deps.getStopWs()
    if (stopWs) {
      try {
        await withTimeout(stopWs(), stepBudgetMs)
      } catch (err) {
        void err
      }
    }
    clearTimeout(safety)
    deps.exit(exitCode)
  }

  const requestFatal = (kind: string, err: Error): Promise<void> => {
    deps.log("ERROR", `fatal (${kind}):`, err.message)
    if (kind === "fd-exhaustion") {
      exitCode = 3
    }
    return shutdown()
  }

  return { shutdown, requestFatal }
}
