import { afterEach, describe, expect, it, vi } from "vitest"
import { createShutdownController } from "../shutdown.js"

afterEach(() => {
  vi.useRealTimers()
})

const defaults = {
  log: () => {},
  stepBudgetMs: 2_000,
  hardBudgetMs: 5_000,
}

describe("createShutdownController", () => {
  it("stops the MCP server then the WS server once, and exits 0", async () => {
    // Given a controller over recording stubs
    const order: string[] = []
    const exit = vi.fn()
    const stopMcp = vi.fn(() => {
      order.push("mcp")
      return Promise.resolve()
    })
    const stopWs = vi.fn(() => {
      order.push("ws")
      return Promise.resolve()
    })
    const controller = createShutdownController({
      ...defaults,
      stopMcp,
      getStopWs: () => stopWs,
      exit,
    })

    // When shutdown runs
    await controller.shutdown()

    // Then both stops run in order and the process exits 0
    expect(order).toEqual(["mcp", "ws"])
    expect(stopMcp).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("is idempotent — a second shutdown does nothing", async () => {
    // Given a controller already asked to shut down
    const exit = vi.fn()
    const stopMcp = vi.fn(() => Promise.resolve())
    const controller = createShutdownController({
      ...defaults,
      stopMcp,
      getStopWs: () => null,
      exit,
    })

    // When shutdown is invoked twice
    await Promise.all([controller.shutdown(), controller.shutdown()])

    // Then the stop and exit happen exactly once
    expect(stopMcp).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it("skips the WS step when no server is bound", async () => {
    // Given a controller with no WS server
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When shutdown runs
    await controller.shutdown()

    // Then it still exits cleanly
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("exits 3 on an fd-exhaustion fatal", async () => {
    // Given a controller
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When a fatal fd-exhaustion is reported
    await controller.requestFatal("fd-exhaustion", new Error("EMFILE"))

    // Then the process exits with code 3
    expect(exit).toHaveBeenCalledWith(3)
  })

  it("exits 0 on a non-fd-exhaustion fatal", async () => {
    // Given a controller
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When some other fatal is reported
    await controller.requestFatal("other", new Error("boom"))

    // Then the default exit code 0 is used
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("does not let a hanging stop step block the exit", async () => {
    // Given a stopMcp that never resolves and a short step budget
    vi.useFakeTimers()
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => new Promise<void>(() => {}),
      getStopWs: () => null,
      exit,
      stepBudgetMs: 50,
      hardBudgetMs: 1_000,
    })

    // When shutdown runs and the step budget elapses
    const done = controller.shutdown()
    await vi.advanceTimersByTimeAsync(60)
    await done

    // Then the budget timeout lets shutdown complete and exit
    expect(exit).toHaveBeenCalledWith(0)
  })
})
