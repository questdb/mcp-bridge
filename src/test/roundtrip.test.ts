import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { BridgeSession } from "../bridgeSession.js"
import {
  startWsServer,
  deriveAllowedOrigins,
  InvalidConsoleOriginError,
} from "../wsServer.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { AnyMessage, ToolSchema } from "../types.js"

const TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWX"

const PORT_POOL = 58000
let nextPort = PORT_POOL

const helloTools: ToolSchema[] = [
  { name: "list_cells", description: "x", inputSchema: { type: "object" } },
  { name: "add_cell", description: "x", inputSchema: { type: "object" } },
]

const startBridge = async (): Promise<{
  port: number
  session: BridgeSession
  stop: () => Promise<void>
}> => {
  const port = nextPort++
  const session = new BridgeSession({
    token: TOKEN,
    getPort: () => port,
    consoleOrigin: "http://127.0.0.1:9000",
    getDeadlineMs: () => null,
  })
  const ws = await startWsServer({
    port,
    token: TOKEN,
    allowedOrigins: ["http://localhost:9000", "http://127.0.0.1:9000"],
    session,
  })
  return { port, session, stop: ws.stop }
}

const open = (
  port: number,
  token: string = TOKEN,
  origin = "http://127.0.0.1:9000",
): Promise<WebSocket> =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`,
      { headers: { origin } },
    )
    ws.once("open", () => resolve(ws))
    ws.once("error", (err) => reject(err))
  })

const openWith = (
  port: number,
  opts: { token?: string; origin?: string; lastSessionId?: string } = {},
): Promise<WebSocket> =>
  new Promise<WebSocket>((resolve, reject) => {
    const params = new URLSearchParams({ token: opts.token ?? TOKEN })
    if (opts.lastSessionId) params.set("lastSessionId", opts.lastSessionId)
    const headers: Record<string, string> = {}
    if (opts.origin !== undefined) headers.origin = opts.origin
    const ws = new WebSocket(`ws://127.0.0.1:${port}?${params.toString()}`, {
      headers,
    })
    ws.once("open", () => resolve(ws))
    ws.once("error", (err) => reject(err))
  })

const hello = (ws: WebSocket): void =>
  send(ws, {
    v: MCP_BRIDGE_VERSION,
    type: "hello",
    token: TOKEN,
    userAgent: "test",
    expectedBridgeVersion: MCP_BRIDGE_VERSION,
    consoleOrigin: "http://127.0.0.1:9000",
    tools: helloTools,
    permissions: { read: true, write: true },
  })

const recv = (ws: WebSocket, timeoutMs = 1000): Promise<AnyMessage> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("recv timeout")), timeoutMs)
    ws.once("message", (data) => {
      clearTimeout(t)
      try {
        let text: string
        if (typeof data === "string") {
          text = data
        } else if (Buffer.isBuffer(data)) {
          text = data.toString("utf-8")
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf-8")
        } else {
          text = Buffer.from(data).toString("utf-8")
        }
        resolve(JSON.parse(text) as AnyMessage)
      } catch (err) {
        reject(err instanceof Error ? err : new Error("parse failed"))
      }
    })
  })

const send = (ws: WebSocket, msg: AnyMessage): void => {
  ws.send(JSON.stringify(msg))
}

const teardown: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of teardown.splice(0)) {
    try {
      await fn()
    } catch (err) {
      void err
    }
  }
})

describe("WebSocket round-trip", () => {
  it("happy path: connect → hello → hello_ack → tool_call → tool_result", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const ws = await open(bridge.port)

    send(ws, {
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: TOKEN,
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: helloTools,
      permissions: { read: true, write: true },
    })
    const ack = await recv(ws)
    expect(ack.type).toBe("hello_ack")
    if (ack.type === "hello_ack") {
      expect(ack.seenToolCount).toBe(2)
    }

    const result = bridge.session.callBrowserTool("list_cells", { x: 1 })
    const call = await recv(ws)
    expect(call.type).toBe("tool_call")
    if (call.type !== "tool_call") throw new Error("no tool_call")
    expect(call.name).toBe("list_cells")

    send(ws, {
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [{ type: "text", text: '{"ok":true}' }],
      isError: false,
    })
    const out = await result
    expect(out.isError).toBe(false)
    expect(out.content[0].text).toBe('{"ok":true}')

    ws.close()
  })

  it("rejects WS upgrade with HTTP 401 on missing token", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    await expect(open(bridge.port, "")).rejects.toThrow()
  })

  it("rejects WS upgrade with HTTP 401 on wrong token", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    await expect(open(bridge.port, "wrong-token")).rejects.toThrow()
  })

  it("rejects WS upgrade with HTTP 403 on disallowed origin", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    await expect(open(bridge.port, TOKEN, "http://attacker.com")).rejects.toThrow()
  })

  it("accepts a loopback-equivalent origin (localhost for a 127.0.0.1 console)", async () => {
    // Given a bridge whose allowlist covers both loopback forms
    const bridge = await startBridge()
    teardown.push(bridge.stop)

    // When a console connects from the localhost form
    const ws = await openWith(bridge.port, { origin: "http://localhost:9000" })
    hello(ws)
    const ack = await recv(ws)

    // Then the upgrade is accepted and pairing proceeds
    expect(ack.type).toBe("hello_ack")
    ws.close()
  })

  it("rejects a WS upgrade that omits the Origin header", async () => {
    // Given a bridge
    const bridge = await startBridge()
    teardown.push(bridge.stop)

    // When a client connects with no Origin header
    // Then the upgrade is refused
    await expect(openWith(bridge.port, { origin: undefined })).rejects.toThrow()
  })

  it("a reconnect echoing the issued sessionId takes over and closes the stale socket", async () => {
    // Given a paired console (socket A) that received a sessionId
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const a = await open(bridge.port)
    hello(a)
    const ack = await recv(a)
    if (ack.type !== "hello_ack") throw new Error("no hello_ack")
    const sessionId = ack.sessionId
    const aClosed = new Promise<number>((resolve) => {
      a.once("close", (code) => resolve(code))
    })

    // When a new socket connects echoing that sessionId and completes the handshake
    const b = await openWith(bridge.port, {
      lastSessionId: sessionId,
      origin: "http://127.0.0.1:9000",
    })
    hello(b)
    const ackB = await recv(b)

    // Then the newcomer takes over and the stale socket is closed (not superseded)
    expect(ackB.type).toBe("hello_ack")
    await aClosed
    b.close()
  })

  it("rejects second concurrent browser with 4001 superseded", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const a = await open(bridge.port)
    send(a, {
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: TOKEN,
      userAgent: "a",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: helloTools,
      permissions: { read: true, write: true },
    })
    await recv(a) // hello_ack
    const b = await open(bridge.port)
    const closeCode = await new Promise<number>((resolve) => {
      b.once("close", (code) => resolve(code))
    })
    expect(closeCode).toBe(4001)
    a.close()
  })

  it("closes with 4005 malformed_json on a non-JSON frame", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const ws = await open(bridge.port)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      )
    })
    ws.send("{ this is not json")
    const { code, reason } = await closed
    expect(code).toBe(4005)
    expect(reason).toBe("malformed_json")
  })

  it("closes with 4005 malformed_message when v/type are absent", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const ws = await open(bridge.port)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      )
    })
    ws.send(JSON.stringify({ hello: "world" })) // valid JSON, no v/type
    const { code, reason } = await closed
    expect(code).toBe(4005)
    expect(reason).toBe("malformed_message")
  })

  it("closes the WS with 4002 on bad token in hello body", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const ws = await open(bridge.port)
    send(ws, {
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: "not-the-token",
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: helloTools,
      permissions: { read: true, write: true },
    })
    const code = await new Promise<number>((resolve) => {
      ws.once("close", (c) => resolve(c))
    })
    expect(code).toBe(4002)
  })

  it("forwards apply_notebook_state through to the browser intact", async () => {
    const bridge = await startBridge()
    teardown.push(bridge.stop)
    const ws = await open(bridge.port)
    send(ws, {
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: TOKEN,
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: [
        {
          name: "apply_notebook_state",
          description: "x",
          inputSchema: { type: "object" },
        },
      ],
      permissions: { read: true, write: true },
    })
    await recv(ws) // hello_ack
    const args = {
      buffer_id: 1,
      cells: [
        { value: "SELECT 1" },
        { id: "abc", value: "SELECT 2", mode: "draw" },
      ],
    }
    const result = bridge.session.callBrowserTool("apply_notebook_state", args)
    const call = await recv(ws)
    expect(call.type).toBe("tool_call")
    if (call.type !== "tool_call") throw new Error("no tool_call")
    expect(call.name).toBe("apply_notebook_state")
    expect(call.arguments).toEqual(args)
    send(ws, {
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [
        { type: "text", text: '{"applied":{"added":["a","b"]}}' },
      ],
      isError: false,
    })
    const out = await result
    expect(out.isError).toBe(false)
    expect(out.content[0].text).toContain("applied")
    ws.close()
  })
})

describe("deriveAllowedOrigins", () => {
  it("expands loopback CONSOLE_ORIGIN to both 127.0.0.1 and localhost forms", () => {
    const out = deriveAllowedOrigins("http://localhost:9000")
    expect(out).toContain("http://localhost:9000")
    expect(out).toContain("http://127.0.0.1:9000")
  })

  it("does NOT expand non-loopback HTTPS origins (strict match)", () => {
    const out = deriveAllowedOrigins("https://console.example.com")
    expect(out).toEqual(["https://console.example.com"])
  })

  it("does NOT include [::1] (HTTP server binds 127.0.0.1 only)", () => {
    const out = deriveAllowedOrigins("http://127.0.0.1:9000")
    expect(out.some((o) => o.includes("[::1]"))).toBe(false)
  })

  it("normalizes a trailing slash in CONSOLE_ORIGIN", () => {
    const out = deriveAllowedOrigins("http://127.0.0.1:9000/")
    expect(out).toContain("http://127.0.0.1:9000")
    expect(out).toContain("http://localhost:9000")
    expect(out.some((o) => o.endsWith("/"))).toBe(false)
  })

  it("accepts an explicit IPv6 origin without expanding it", () => {
    const out = deriveAllowedOrigins("http://[::1]:9000")
    expect(out).toEqual(["http://[::1]:9000"])
  })

  describe("rejects malformed CONSOLE_ORIGIN with InvalidConsoleOriginError", () => {
    const cases: Array<{ input: string; expectInMessage: string }> = [
      { input: "localhost:1234", expectInMessage: "must use http:// or https://" },
      { input: "0.0.0.0:1234", expectInMessage: "is not a valid URL" },
      { input: "1.2.3.4:1234", expectInMessage: "is not a valid URL" },
      { input: "somedomain.com", expectInMessage: "is not a valid URL" },
      { input: "not a url", expectInMessage: "is not a valid URL" },
      { input: "file:///etc/passwd", expectInMessage: "must use http:// or https://" },
    ]
    for (const { input, expectInMessage } of cases) {
      it(`rejects "${input}"`, () => {
        expect(() => deriveAllowedOrigins(input)).toThrow(
          InvalidConsoleOriginError,
        )
        expect(() => deriveAllowedOrigins(input)).toThrow(expectInMessage)
      })
    }
  })
})
