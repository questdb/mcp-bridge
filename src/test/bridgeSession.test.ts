import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BridgeSession,
  type BrowserConn,
  type BridgeSessionConfig,
} from "../bridgeSession.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { WS_CLOSE_CODES, type AnyMessage, type ToolSchema } from "../types.js"

const helloTools: ToolSchema[] = [
  { name: "list_cells", description: "x", inputSchema: { type: "object" } },
  { name: "add_cell", description: "x", inputSchema: { type: "object" } },
]

const makeFakeBrowser = () => {
  const sent: AnyMessage[] = []
  let closed: { code: number; reason: string } | null = null
  let terminated = false
  const conn: BrowserConn = {
    send: (msg) => {
      sent.push(msg)
    },
    close: (code, reason) => {
      closed = { code, reason }
    },
    terminate: () => {
      terminated = true
    },
  }
  return {
    conn,
    sent,
    get closed() {
      return closed
    },
    get terminated() {
      return terminated
    },
  }
}

const makeSession = (
  override: Partial<BridgeSessionConfig> = {},
): { session: BridgeSession } => {
  const session = new BridgeSession({
    token: "the-token",
    getPort: () => 57123,
    consoleOrigin: "http://127.0.0.1:9000",
    getDeadlineMs: (n) => (n === "run_cell" ? 300_000 : 15_000),
    ...override,
  })
  return { session }
}

const sendHello = (
  session: BridgeSession,
  token = "the-token",
  tools = helloTools,
  permissions: { read: boolean; write: boolean } = { read: true, write: true },
  expectedBridgeVersion: string = MCP_BRIDGE_VERSION,
) => {
  session.handleMessage({
    v: expectedBridgeVersion,
    type: "hello",
    token,
    userAgent: "test",
    expectedBridgeVersion,
    consoleOrigin: "http://127.0.0.1:9000",
    tools,
    permissions,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("BridgeSession — pairing handshake", () => {
  it("accepts hello with valid token and transitions to S1", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    expect(session.attachBrowser(browser.conn)).toBe("accepted")
    sendHello(session)
    expect(session.getState()).toBe("S1")
    const ack = browser.sent[0]
    expect(ack.type).toBe("hello_ack")
    if (ack.type === "hello_ack") {
      expect(ack.seenToolCount).toBe(2)
    }
  })

  it("mirrors hello.permissions into the pairing snapshot for relay to the MCP client", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", helloTools, { read: true, write: false })
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.permissions).toEqual({ read: true, write: false })
  })

  it("updates the mirrored permissions when a fresh hello arrives on a new session", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session, "the-token", helloTools, { read: true, write: true })
    expect(session.getPairingSnapshot()).toMatchObject({
      permissions: { read: true, write: true },
    })

    session.handleSocketClose(a.conn)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session, "the-token", helloTools, { read: false, write: false })
    expect(session.getPairingSnapshot()).toMatchObject({
      permissions: { read: false, write: false },
    })
  })

  it("rejects hello with wrong token via 4002 close", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "wrong-token")
    expect(browser.closed).toEqual({
      code: WS_CLOSE_CODES.token_invalid,
      reason: "token_mismatch",
    })
  })

  it("ignores a pipelined good-token hello after a bad-token close (no auth retry on the same conn)", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "wrong-token")
    expect(browser.closed?.code).toBe(WS_CLOSE_CODES.token_invalid)
    sendHello(session)
    expect(session.getState()).toBe("S0")
    expect(session.getPairingSnapshot().paired).toBe(false)
    session.handleSocketClose(browser.conn)
    expect(session.getState()).toBe("S0")
  })

  it("rejects a duplicate hello while in S1 with protocol_violation", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    expect(session.getState()).toBe("S1")
    sendHello(session)
    expect(browser.closed?.code).toBe(WS_CLOSE_CODES.protocol_violation)
    expect(browser.closed?.reason).toBe("duplicate_hello")
  })

  it("rejects a second browser while paired with 'superseded'", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const b = makeFakeBrowser()
    expect(session.attachBrowser(b.conn)).toBe("superseded")
  })

  it("rejects malformed hello.tools without crashing", () => {
    for (const badTools of [
      null,
      "not-an-array",
      [null],
      [{ description: "missing name" }],
      [{ name: 42 }],
    ] as unknown[]) {
      const { session } = makeSession()
      const browser = makeFakeBrowser()
      session.attachBrowser(browser.conn)
      expect(() =>
        session.handleMessage({
          v: MCP_BRIDGE_VERSION,
          type: "hello",
          token: "the-token",
          userAgent: "test",
          expectedBridgeVersion: MCP_BRIDGE_VERSION,
          consoleOrigin: "http://127.0.0.1:9000",
          tools: badTools,
          permissions: { read: true, write: true },
        } as unknown as Parameters<typeof session.handleMessage>[0]),
      ).not.toThrow()
      expect(browser.closed?.code).toBe(WS_CLOSE_CODES.protocol_violation)
      expect(browser.closed?.reason).toBe("malformed_hello_tools")
      expect(session.getState()).toBe("S0")
    }
  })

  it("times out hello and closes with 4005 protocol_violation", () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    vi.advanceTimersByTime(11_000)
    expect(browser.closed?.code).toBe(WS_CLOSE_CODES.protocol_violation)
    expect(browser.closed?.reason).toBe("hello_timeout")
  })

  it("rejects a second browser that arrives BEFORE the first sent hello (single-owner)", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    expect(session.attachBrowser(a.conn)).toBe("accepted")
    const b = makeFakeBrowser()
    expect(session.attachBrowser(b.conn)).toBe("superseded")
  })

  it("hard-rejects a hello whose expectedBridgeVersion is a different major", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(
      session,
      "the-token",
      helloTools,
      { read: true, write: true },
      "999.0.0",
    )
    expect(browser.closed?.code).toBe(WS_CLOSE_CODES.major_version_mismatch)
    expect(browser.closed?.reason).toBe("major_version_mismatch")
    expect(session.getState()).toBe("S0")
  })

  it("accepts a same-major drift and records the mismatch in the snapshot", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(
      session,
      "the-token",
      helloTools,
      { read: true, write: true },
      `${parseInt(MCP_BRIDGE_VERSION.split(".")[0], 10)}.9999.99`,
    )
    expect(session.getState()).toBe("S1")
    expect(browser.closed).toBeNull()
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.versionMismatch).not.toBeNull()
    expect(snap.versionMismatch?.bridgeVersion).toBe(MCP_BRIDGE_VERSION)
    expect(snap.versionMismatch?.expectedBridgeVersion).toMatch(/\.9999\.99$/)
  })

  it("records no mismatch when bridge and UI agree exactly on the version", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    expect(session.getState()).toBe("S1")
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.versionMismatch).toBeNull()
  })
})

describe("BridgeSession — heartbeat", () => {
  it("terminates the browser when no pong arrives (force-RST, not graceful close)", () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    vi.advanceTimersByTime(5_000)
    const ping = browser.sent.find((m) => m.type === "ping")
    expect(ping).toBeTruthy()
    vi.advanceTimersByTime(10_000)
    expect(browser.terminated).toBe(true)
    expect(browser.closed).toBeNull()
  })
})

describe("BridgeSession — tool calls", () => {
  it("forwards tool_call when paired and resolves on tool_result", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeTruthy()
    if (call?.type !== "tool_call") throw new Error("no tool_call")
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [{ type: "text", text: "ok" }],
      isError: false,
    })
    const out = await result
    expect(out.isError).toBe(false)
    expect(out.content[0].text).toBe("ok")
  })

  it("times out tool_call after deadline and sends cancel", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({
      getDeadlineMs: () => 100,
    })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = session.callBrowserTool("instant_thing", {})
    vi.advanceTimersByTime(200)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/timeout/)
    const cancel = browser.sent.find((m) => m.type === "cancel")
    expect(cancel).toBeTruthy()
  })

  it("returns BRIDGE_NOT_PAIRED when no browser and a tool is called", async () => {
    const { session } = makeSession()
    const out = await session.callBrowserTool("list_cells", {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/BRIDGE_NOT_PAIRED/)
    expect(out.content[0].text).toMatch(/get_pairing_credentials/)
  })

  it("aborts in-flight tool_call when caller signal fires, sends cancel to browser", async () => {
    const { session } = makeSession({ getDeadlineMs: () => null })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const ac = new AbortController()
    const result = session.callBrowserTool("list_cells", {}, ac.signal)
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeTruthy()
    ac.abort()
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/cancelled/)
    const cancel = browser.sent.find((m) => m.type === "cancel")
    expect(cancel).toBeTruthy()
  })

  it("short-circuits to cancelled when caller signal is already aborted", async () => {
    const { session } = makeSession({ getDeadlineMs: () => null })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const ac = new AbortController()
    ac.abort()
    const out = await session.callBrowserTool("list_cells", {}, ac.signal)
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/cancelled/)
    expect(browser.sent.find((m) => m.type === "tool_call")).toBeUndefined()
  })

  it("does not fire abort handler after tool_result resolves the call", async () => {
    const { session } = makeSession({ getDeadlineMs: () => null })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const ac = new AbortController()
    const result = session.callBrowserTool("list_cells", {}, ac.signal)
    const call = browser.sent.find((m) => m.type === "tool_call")
    if (call?.type !== "tool_call") throw new Error("no tool_call")
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [{ type: "text", text: "done" }],
      isError: false,
    })
    const out = await result
    expect(out.isError).toBe(false)
    expect(out.content[0].text).toBe("done")
    ac.abort()
    // No "cancel" message — call already finished.
    expect(browser.sent.find((m) => m.type === "cancel")).toBeUndefined()
  })

  it("silently drops tool_result for unknown requestId", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    expect(() =>
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "tool_result",
        requestId: "nonexistent",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      }),
    ).not.toThrow()
  })
})

describe("BridgeSession — disconnect", () => {
  it("falls straight to S0 on socket close", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    session.handleSocketClose(browser.conn)
    expect(session.getState()).toBe("S0")
  })

  it("rejects in-flight tool calls on disconnect", async () => {
    const { session } = makeSession({
      getDeadlineMs: () => null,
    })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})
    session.handleSocketClose(browser.conn)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/browser_disconnected/)
  })

  it("a fresh browser after disconnect re-establishes via new hello", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    session.handleSocketClose(a.conn)
    expect(session.getState()).toBe("S0")
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session)
    expect(session.getState()).toBe("S1")
  })

  it("ignores a stale close from a previously-replaced browser", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session, "wrong-token")
    expect(session.getState()).toBe("S0")
    session.handleSocketClose(a.conn)
    expect(session.getState()).toBe("S0")
    const b = makeFakeBrowser()
    expect(session.attachBrowser(b.conn)).toBe("accepted")
    sendHello(session)
    expect(session.getState()).toBe("S1")
    session.handleSocketClose(a.conn)
    expect(session.getState()).toBe("S1")
    expect(session.getPairingSnapshot().paired).toBe(true)
  })
})

describe("BridgeSession — wait_for_pairing", () => {
  it("resolves immediately when already paired", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = await session.waitForPair(1_000)
    expect(result.paired).toBe(true)
    if (result.paired) {
      expect(result.consoleOrigin).toBe("http://127.0.0.1:9000")
    }
  })

  it("resolves on the next S1 entry", async () => {
    const { session } = makeSession()
    const promise = session.waitForPair(60_000)
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = await promise
    expect(result.paired).toBe(true)
  })

  it("resolves with paired:false on timeout", async () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const promise = session.waitForPair(1_000)
    vi.advanceTimersByTime(2_000)
    const result = await promise
    expect(result.paired).toBe(false)
    vi.useRealTimers()
  })

  it("at the cap, rejects the new arrival rather than evicting the oldest", async () => {
    const { session } = makeSession()
    const existing: Array<{
      resolved: boolean
      promise: Promise<unknown>
    }> = []
    for (let i = 0; i < 32; i++) {
      const p = session.waitForPair(60_000)
      const tracker = { resolved: false, promise: p }
      void p.then(() => {
        tracker.resolved = true
      })
      existing.push(tracker)
    }
    const overflow = await session.waitForPair(60_000)
    expect(overflow.paired).toBe(false)
    expect("rateLimited" in overflow && overflow.rateLimited).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(existing.every((t) => !t.resolved)).toBe(true)
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const results = await Promise.all(existing.map((t) => t.promise))
    expect(results.every((r) => (r as { paired: boolean }).paired)).toBe(true)
  })
})

describe("BridgeSession — getPairingSnapshot", () => {
  it("snapshot is paired:false before hello, paired:true after", () => {
    const { session } = makeSession()
    expect(session.getPairingSnapshot().paired).toBe(false)
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const snap = session.getPairingSnapshot()
    expect(snap.paired).toBe(true)
    if (snap.paired) {
      expect(snap.consoleOrigin).toBe("http://127.0.0.1:9000")
      expect(snap.permissions).toEqual({ read: true, write: true })
      expect(snap.versionMismatch).toBeNull()
    }
  })
})

describe("BridgeSession — deep link", () => {
  it("buildDeepLink combines CONSOLE_ORIGIN + port + token", () => {
    const { session } = makeSession()
    const link = session.buildDeepLink()
    expect(link).toContain("http://127.0.0.1:9000")
    expect(link).toContain("mcp-pair=1")
    expect(link).toContain("ws%3A%2F%2F127.0.0.1%3A57123")
    expect(link).toContain("the-token")
  })
})
