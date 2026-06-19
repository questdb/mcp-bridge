import { describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  createBrowserConn,
  handleServerRuntimeError,
  type FatalErrorKind,
} from "../wsServer.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { AnyMessage } from "../types.js"

const ping: AnyMessage = { v: MCP_BRIDGE_VERSION, type: "ping", nonce: "n" }

const makeFakeSocket = (
  over: { readyState?: number; bufferedAmount?: number } = {},
) => {
  const sent: string[] = []
  let terminated = false
  return {
    readyState: over.readyState ?? WebSocket.OPEN,
    bufferedAmount: over.bufferedAmount ?? 0,
    send: (data: string) => {
      sent.push(data)
    },
    close: () => {},
    terminate: () => {
      terminated = true
    },
    get sent() {
      return sent
    },
    get terminated() {
      return terminated
    },
  }
}

describe("createBrowserConn — outbound send", () => {
  it("sends the serialized frame when the socket is open and under the buffer limit", () => {
    // Given an open socket with an empty outbound buffer
    const socket = makeFakeSocket()
    const conn = createBrowserConn(socket, {})

    // When a frame is sent
    conn.send(ping)

    // Then it is serialized and written, and the socket is not terminated
    expect(socket.sent).toEqual([JSON.stringify(ping)])
    expect(socket.terminated).toBe(false)
  })

  it("drops the frame and terminates when the outbound buffer is over the limit", () => {
    // Given a socket whose buffered amount exceeds the configured limit
    const socket = makeFakeSocket({ bufferedAmount: 11 })
    const log = vi.fn()
    const conn = createBrowserConn(socket, { bufferLimitBytes: 10, log })

    // When a frame is sent
    conn.send(ping)

    // Then nothing is written, the socket is terminated, and it is logged
    expect(socket.sent).toEqual([])
    expect(socket.terminated).toBe(true)
    expect(log).toHaveBeenCalledWith("WARN", expect.stringContaining("overflow"))
  })

  it("does not send when the socket is not open", () => {
    // Given a closing socket
    const socket = makeFakeSocket({ readyState: WebSocket.CLOSING })
    const conn = createBrowserConn(socket, {})

    // When a frame is sent
    conn.send(ping)

    // Then nothing is written
    expect(socket.sent).toEqual([])
  })
})

describe("handleServerRuntimeError", () => {
  const fdCodes = ["EMFILE", "ENFILE"]

  for (const code of fdCodes) {
    it(`escalates ${code} as an fd-exhaustion fatal`, () => {
      // Given a runtime error signalling file-descriptor exhaustion
      const err = Object.assign(new Error(code), { code })
      const onFatalError = vi.fn<(kind: FatalErrorKind, err: Error) => void>()

      // When the error is handled
      handleServerRuntimeError(err, { onFatalError })

      // Then it is escalated to the fatal handler
      expect(onFatalError).toHaveBeenCalledWith("fd-exhaustion", err)
    })
  }

  it("does not escalate a non-fd-exhaustion error", () => {
    // Given an ordinary runtime error
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" })
    const onFatalError = vi.fn<(kind: FatalErrorKind, err: Error) => void>()

    // When the error is handled
    handleServerRuntimeError(err, { onFatalError })

    // Then the fatal handler is not called
    expect(onFatalError).not.toHaveBeenCalled()
  })

  it("warns when fd-exhaustion has no fatal handler registered", () => {
    // Given an fd-exhaustion error and no onFatalError handler
    const err = Object.assign(new Error("EMFILE"), { code: "EMFILE" })
    const log = vi.fn()

    // When the error is handled
    handleServerRuntimeError(err, { log })

    // Then it warns about the degraded state
    expect(log).toHaveBeenCalledWith("WARN", expect.stringContaining("degraded"))
  })
})
