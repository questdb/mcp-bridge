import type { Log } from "./types.js"

export type AttemptListenFn = (
  port: number,
) => Promise<{ stop: () => Promise<void> }>

const isEaddrInUse = (err: unknown): boolean =>
  err instanceof Error &&
  (err as Error & { code?: string }).code === "EADDRINUSE"

export const bindWithRetry = async (params: {
  port: number
  isPinned: boolean
  attemptListen: AttemptListenFn
  findFreePort: () => Promise<number>
  log?: Log
}): Promise<{ stop: () => Promise<void>; port: number }> => {
  const { port, isPinned, attemptListen, findFreePort, log: logger } = params
  try {
    const handle = await attemptListen(port)
    return { ...handle, port }
  } catch (err) {
    if (!isEaddrInUse(err)) throw err
    if (isPinned) {
      const tagged = new Error(
        `could not bind MCP_BRIDGE_PORT=${port} (EADDRINUSE). ` +
          `Pick a different port or unset MCP_BRIDGE_PORT to auto-allocate.`,
      )
      ;(tagged as Error & { code?: string }).code = "port-pinned-in-use"
      throw tagged
    }
    logger?.("WARN", `port ${port} taken before bind; retrying with a fresh port`)
    const nextPort = await findFreePort()
    try {
      const handle = await attemptListen(nextPort)
      return { ...handle, port: nextPort }
    } catch (retryErr) {
      const tagged = new Error(
        `auto-allocated port ${nextPort} also taken (${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }). Restart the bridge to pick another.`,
      )
      ;(tagged as Error & { code?: string }).code = "port-exhausted"
      throw tagged
    }
  }
}
