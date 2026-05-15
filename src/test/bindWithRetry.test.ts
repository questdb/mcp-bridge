import { describe, expect, it, vi } from "vitest"
import { bindWithRetry, type AttemptListenFn } from "../bindWithRetry.js"

const noopStop = (): Promise<void> => Promise.resolve()

const stubListen = (calls: number[]): AttemptListenFn => (p) => {
  calls.push(p)
  return Promise.resolve({ stop: noopStop })
}

const eaddrinuseError = (port: number): Error => {
  const err = new Error(
    `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
  )
  ;(err as Error & { code?: string }).code = "EADDRINUSE"
  return err
}

describe("bindWithRetry", () => {
  it("returns the first-attempt result when bind succeeds", async () => {
    const listenCalls: number[] = []
    const findFreePort = vi.fn(() => Promise.resolve(99999))
    const result = await bindWithRetry({
      port: 5000,
      isPinned: false,
      attemptListen: stubListen(listenCalls),
      findFreePort,
    })
    expect(result.port).toBe(5000)
    expect(listenCalls).toEqual([5000])
    expect(findFreePort).not.toHaveBeenCalled()
  })

  it("retries with a fresh port on EADDRINUSE for auto-allocated", async () => {
    const listenCalls: number[] = []
    let firstAttempt = true
    const attemptListen: AttemptListenFn = (p) => {
      listenCalls.push(p)
      if (firstAttempt) {
        firstAttempt = false
        return Promise.reject(eaddrinuseError(p))
      }
      return Promise.resolve({ stop: noopStop })
    }
    const findFreePort = vi.fn(() => Promise.resolve(6000))
    const log = vi.fn()
    const result = await bindWithRetry({
      port: 5000,
      isPinned: false,
      attemptListen,
      findFreePort,
      log,
    })
    expect(result.port).toBe(6000)
    expect(listenCalls).toEqual([5000, 6000])
    expect(findFreePort).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      "WARN",
      "port 5000 taken before bind; retrying with a fresh port",
    )
  })

  it("does NOT retry when the port is pinned (MCP_BRIDGE_PORT set)", async () => {
    const listenCalls: number[] = []
    const attemptListen: AttemptListenFn = (p) => {
      listenCalls.push(p)
      return Promise.reject(eaddrinuseError(p))
    }
    const findFreePort = vi.fn(() => Promise.resolve(6000))
    await expect(
      bindWithRetry({
        port: 5000,
        isPinned: true,
        attemptListen,
        findFreePort,
      }),
    ).rejects.toMatchObject({ code: "port-pinned-in-use" })
    expect(listenCalls).toEqual([5000])
    expect(findFreePort).not.toHaveBeenCalled()
  })

  it("throws port-exhausted when both attempts hit EADDRINUSE", async () => {
    const listenCalls: number[] = []
    const attemptListen: AttemptListenFn = (p) => {
      listenCalls.push(p)
      return Promise.reject(eaddrinuseError(p))
    }
    const findFreePort = vi.fn(() => Promise.resolve(6000))
    await expect(
      bindWithRetry({
        port: 5000,
        isPinned: false,
        attemptListen,
        findFreePort,
      }),
    ).rejects.toMatchObject({ code: "port-exhausted" })
    expect(listenCalls).toEqual([5000, 6000])
  })

  it("propagates non-EADDRINUSE errors without retrying", async () => {
    const listenCalls: number[] = []
    const attemptListen: AttemptListenFn = (p) => {
      listenCalls.push(p)
      return Promise.reject(new Error("EACCES: permission denied"))
    }
    const findFreePort = vi.fn(() => Promise.resolve(6000))
    await expect(
      bindWithRetry({
        port: 5000,
        isPinned: false,
        attemptListen,
        findFreePort,
      }),
    ).rejects.toThrow(/EACCES/)
    expect(listenCalls).toEqual([5000])
    expect(findFreePort).not.toHaveBeenCalled()
  })

  it("detects EADDRINUSE via err.code, not message text", async () => {
    const listenCalls: number[] = []
    let firstAttempt = true
    const attemptListen: AttemptListenFn = (p) => {
      listenCalls.push(p)
      if (firstAttempt) {
        firstAttempt = false
        const err = new Error("address already in use")
        ;(err as Error & { code?: string }).code = "EADDRINUSE"
        return Promise.reject(err)
      }
      return Promise.resolve({ stop: noopStop })
    }
    const findFreePort = vi.fn(() => Promise.resolve(6000))
    const result = await bindWithRetry({
      port: 5000,
      isPinned: false,
      attemptListen,
      findFreePort,
    })
    expect(result.port).toBe(6000)
    expect(listenCalls).toEqual([5000, 6000])
  })
})
