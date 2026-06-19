import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BridgeSession,
  type BrowserConn,
  type BridgeSessionConfig,
} from "../bridgeSession.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import {
  WS_CLOSE_CODES,
  type AnyMessage,
  type MCPPermissions,
  type ToolSchema,
} from "../types.js"

const grantedPermissions: MCPPermissions = {
  grantSchemaAccess: true,
  read: true,
  write: true,
}

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
  permissions: MCPPermissions = grantedPermissions,
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

const getSessionId = (session: BridgeSession): string => {
  const snap = session.getPairingSnapshot()
  if (!snap.paired) throw new Error("expected paired")
  return snap.sessionId
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
    sendHello(session, "the-token", helloTools, {
      grantSchemaAccess: true,
      read: true,
      write: false,
    })
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.permissions).toEqual({
      grantSchemaAccess: true,
      read: true,
      write: false,
    })
  })

  it("updates the mirrored permissions when a fresh hello arrives on a new session", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session, "the-token", helloTools, grantedPermissions)
    expect(session.getPairingSnapshot()).toMatchObject({
      permissions: grantedPermissions,
    })

    session.handleSocketClose(a.conn)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session, "the-token", helloTools, {
      grantSchemaAccess: false,
      read: false,
      write: false,
    })
    expect(session.getPairingSnapshot()).toMatchObject({
      permissions: { grantSchemaAccess: false, read: false, write: false },
    })
  })

  it("denies all permissions when hello.permissions is missing", () => {
    // Given a session awaiting a hello
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)

    // When the hello omits permissions entirely
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: "the-token",
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: helloTools,
    } as unknown as Parameters<BridgeSession["handleMessage"]>[0])

    // Then it pairs but grants nothing
    expect(session.getState()).toBe("S1")
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.permissions).toEqual({
      grantSchemaAccess: false,
      read: false,
      write: false,
    })
  })

  it("denies all permissions when hello.permissions is ill-typed", () => {
    // Given a session awaiting a hello
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)

    // When the hello carries non-boolean permissions
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: "the-token",
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: helloTools,
      permissions: { grantSchemaAccess: 1, read: "yes", write: 1 },
    } as unknown as Parameters<BridgeSession["handleMessage"]>[0])

    // Then it grants nothing
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    expect(snap.permissions).toEqual({
      grantSchemaAccess: false,
      read: false,
      write: false,
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

  it("supersedes a second browser that presents a wrong or absent sessionId", () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const b = makeFakeBrowser()
    expect(session.attachBrowser(b.conn, "not-the-session")).toBe("superseded")
    expect(session.attachBrowser(b.conn, undefined)).toBe("superseded")
    expect(a.terminated).toBe(false)
  })

  it("lets a reconnect with the issued sessionId take over the slot before the stale socket closes", async () => {
    const { session } = makeSession({ getDeadlineMs: () => null })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const snap = session.getPairingSnapshot()
    if (!snap.paired) throw new Error("expected paired")
    const sessionId = snap.sessionId

    const result = session.callBrowserTool("list_cells", {})
    const call = a.sent.find((m) => m.type === "tool_call") as {
      requestId: string
    }

    // The stale socket is dead but its close has not fired yet — the reconnect
    // arrives while `this.browser` still points at it.
    const b = makeFakeBrowser()
    expect(session.attachBrowser(b.conn, sessionId)).toBe("accepted")
    expect(a.terminated).toBe(true)

    sendHello(session)
    expect(session.getState()).toBe("S1")
    expect(b.sent.some((m) => m.type === "hello_ack")).toBe(true)
    const after = session.getPairingSnapshot()
    if (!after.paired) throw new Error("expected paired after takeover")
    expect(after.sessionId).toBe(sessionId)

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
      grantedPermissions,
      "999.0.0",
    )
    expect(browser.closed?.code).toBe(WS_CLOSE_CODES.major_version_mismatch)
    expect(browser.closed?.reason).toBe("major_version_mismatch")
    expect(session.getState()).toBe("S0")
  })

  it("remembers a refused major-mismatch console so the pairing tools can surface an upgrade notice", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(
      session,
      "the-token",
      helloTools,
      grantedPermissions,
      "999.0.0",
    )
    const snap = session.getPairingSnapshot()
    expect(snap.paired).toBe(false)
    if (snap.paired) throw new Error("expected unpaired")
    expect(snap.incompatible).toEqual({
      bridgeVersion: MCP_BRIDGE_VERSION,
      expectedBridgeVersion: "999.0.0",
    })
    // waitForPair resolves immediately instead of blocking the full timeout.
    const waited = await session.waitForPair(50_000)
    expect(waited.paired).toBe(false)
    if (waited.paired || "rateLimited" in waited) {
      throw new Error("expected incompatible result")
    }
    expect(waited.incompatible?.expectedBridgeVersion).toBe("999.0.0")
  })

  it("resolves an already-parked waiter with incompatible when a refused console connects", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    // Park a waiter first — this is the common flow: the agent calls
    // wait_for_pairing and blocks, THEN the user opens an incompatible console.
    const pending = session.waitForPair(50_000)
    sendHello(
      session,
      "the-token",
      helloTools,
      grantedPermissions,
      "999.0.0",
    )
    const waited = await pending
    expect(waited.paired).toBe(false)
    if (waited.paired || "rateLimited" in waited) {
      throw new Error("expected incompatible result")
    }
    expect(waited.incompatible?.expectedBridgeVersion).toBe("999.0.0")
  })

  it("accepts a same-major drift and records the mismatch in the snapshot", () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(
      session,
      "the-token",
      helloTools,
      grantedPermissions,
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

  it("stays alive while the console answers each ping with a matching pong", () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    // Five heartbeat rounds (25s), each answered — must never terminate.
    for (let round = 0; round < 5; round++) {
      vi.advanceTimersByTime(5_000)
      const ping = [...browser.sent].reverse().find((m) => m.type === "ping")
      if (ping?.type !== "ping") throw new Error("expected a ping")
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "pong",
        nonce: ping.nonce,
      })
    }
    expect(browser.terminated).toBe(false)
  })

  it("waits the full pong timeout (not one heartbeat interval) before terminating", () => {
    // Guards the fix: the 5s interval must NOT collapse the 10s pong tolerance.
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    vi.advanceTimersByTime(5_000) // ping sent at t=5s
    vi.advanceTimersByTime(9_999) // a second interval elapses; must NOT terminate yet
    expect(browser.terminated).toBe(false)
    vi.advanceTimersByTime(1) // t=15s → 10s after the ping → terminate
    expect(browser.terminated).toBe(true)
  })

  it("ignores a pong with a stale nonce and still times out the unanswered ping", () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    vi.advanceTimersByTime(5_000)
    expect(browser.sent.find((m) => m.type === "ping")).toBeTruthy()
    // A pong for the wrong nonce must not clear the outstanding ping.
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "pong",
      nonce: "not-the-live-nonce",
    })
    vi.advanceTimersByTime(10_000)
    expect(browser.terminated).toBe(true)
  })

  it("answers an inbound ping with a pong echoing the nonce", () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "ping",
      nonce: "abc123",
    })
    const pong = browser.sent.find((m) => m.type === "pong")
    expect(pong?.type).toBe("pong")
    if (pong?.type === "pong") expect(pong.nonce).toBe("abc123")
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

  it("timeout result carries do-not-retry guidance for data-modifying calls", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({ getDeadlineMs: () => 100 })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = session.callBrowserTool("run_cell", {})
    vi.advanceTimersByTime(200)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/timeout/)
    expect(out.content[0].text).toMatch(/may have completed/)
    expect(out.content[0].text).toMatch(/do NOT retry/)
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

  it("keeps in-flight calls alive across a disconnect and resolves them from a reconnect flush", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({
      getDeadlineMs: () => null,
    })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const sessionId = getSessionId(session)
    const result = session.callBrowserTool("list_cells", {})
    const call = a.sent.find((m) => m.type === "tool_call") as {
      requestId: string
    }
    session.handleSocketClose(a.conn)

    vi.advanceTimersByTime(3_000)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn, sessionId)
    sendHello(session)
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

  it("clears the grace timer on reconnect so a long call survives past the grace window", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({ getDeadlineMs: () => null })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const sessionId = getSessionId(session)
    const result = session.callBrowserTool("list_cells", {})
    const call = a.sent.find((m) => m.type === "tool_call") as {
      requestId: string
    }
    // Drop, then the same console reconnects well within the grace window.
    session.handleSocketClose(a.conn)
    vi.advanceTimersByTime(3_000)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn, sessionId)
    sendHello(session)
    // Now let MORE than a full grace window elapse since the original drop. The
    // reconnected console is still executing and only flushes its result now —
    // without clearing grace on reconnect, the call would already be failed.
    vi.advanceTimersByTime(40_000)
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

  it("re-arms a fresh grace window on a second disconnect after reconnect", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({ getDeadlineMs: () => null })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const sessionId1 = getSessionId(session)
    const result = session.callBrowserTool("list_cells", {})
    const call = a.sent.find((m) => m.type === "tool_call") as {
      requestId: string
    }
    // Drop #1 at t=0 → grace would fire at t=30s.
    session.handleSocketClose(a.conn)
    vi.advanceTimersByTime(5_000) // t=5s
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn, sessionId1)
    sendHello(session) // reconnect #1 clears grace and mints a new id
    const sessionId2 = getSessionId(session)
    vi.advanceTimersByTime(5_000) // t=10s
    // Drop #2: a fresh 30s grace must start now (→ t=40s), not stay anchored to
    // drop #1's t=30s.
    session.handleSocketClose(b.conn)
    vi.advanceTimersByTime(25_000) // t=35s: past drop #1's window, before drop #2's
    const c = makeFakeBrowser()
    session.attachBrowser(c.conn, sessionId2)
    sendHello(session)
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [{ type: "text", text: "late-but-ok" }],
      isError: false,
    })
    const out = await result
    expect(out.isError).toBe(false)
    expect(out.content[0].text).toBe("late-but-ok")
  })

  it("fails a disconnect-spanning call after the grace window with an unverified-completion warning", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({
      getDeadlineMs: () => null,
    })
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})
    session.handleSocketClose(browser.conn)

    vi.advanceTimersByTime(30_000)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/browser_disconnected/)
    expect(out.content[0].text).toMatch(/may have completed/)
    expect(out.content[0].text).toMatch(/do NOT retry/)
  })

  it("keeps the orphaned call's grace running when a different console pairs during the window", async () => {
    // Given a paired console with an in-flight call, with grace as the only
    // settler (null deadline) so a wrongly-cancelled grace would leak forever
    vi.useFakeTimers()
    const { session } = makeSession({ getDeadlineMs: () => null })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})

    // When it drops and a different console pairs within the window (a new tab,
    // so no echoed sessionId)
    session.handleSocketClose(a.conn)
    vi.advanceTimersByTime(5_000)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session)
    expect(session.getState()).toBe("S1")

    // Then the orphaned call still fails at the grace deadline, not stranded
    vi.advanceTimersByTime(25_000)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/browser_disconnected/)
    expect(out.content[0].text).toMatch(/do NOT retry/)
  })

  it("keeps the orphaned call's grace running when a reconnect echoes a wrong sessionId", async () => {
    // Given a paired console with an in-flight call and a null deadline
    vi.useFakeTimers()
    const { session } = makeSession({ getDeadlineMs: () => null })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})

    // When it drops and a socket reconnects presenting a non-matching sessionId
    session.handleSocketClose(a.conn)
    vi.advanceTimersByTime(5_000)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn, "s-not-the-session")
    sendHello(session)

    // Then grace stands and the call fails at the deadline
    vi.advanceTimersByTime(25_000)
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/browser_disconnected/)
  })

  it("a result flushed after grace expiry is dropped, not double-resolved", async () => {
    vi.useFakeTimers()
    const { session } = makeSession({
      getDeadlineMs: () => null,
    })
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session)
    const result = session.callBrowserTool("list_cells", {})
    const call = a.sent.find((m) => m.type === "tool_call") as {
      requestId: string
    }
    session.handleSocketClose(a.conn)
    vi.advanceTimersByTime(30_000)
    const out = await result
    expect(out.isError).toBe(true)

    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session)
    expect(() =>
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "tool_result",
        requestId: call.requestId,
        content: [{ type: "text", text: "late" }],
        isError: false,
      }),
    ).not.toThrow()
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

  it("clears a refused console's incompatible flag on disconnect so pairing can resume", async () => {
    const { session } = makeSession()
    const a = makeFakeBrowser()
    session.attachBrowser(a.conn)
    sendHello(session, "the-token", helloTools, grantedPermissions, "999.0.0")
    // While the refused socket is attached, the snapshot reports incompatible.
    const before = session.getPairingSnapshot()
    if (before.paired) throw new Error("expected unpaired")
    expect(before.incompatible).toBeTruthy()
    // The refused socket drops. The incompatible fact is per-connection and must
    // not outlive it, or the agent is told to stop polling forever.
    session.handleSocketClose(a.conn)
    const after = session.getPairingSnapshot()
    if (after.paired) throw new Error("expected unpaired")
    expect(after.incompatible).toBeUndefined()
    // A fresh waiter now parks for a new console instead of short-circuiting.
    const pending = session.waitForPair(50_000)
    const b = makeFakeBrowser()
    session.attachBrowser(b.conn)
    sendHello(session)
    const res = await pending
    expect(res.paired).toBe(true)
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
      expect(snap.permissions).toEqual(grantedPermissions)
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

describe("BridgeSession — tool argument validation", () => {
  const strictTools: ToolSchema[] = [
    {
      name: "update_cell",
      description: "x",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          buffer_id: { type: "number" },
          cell_id: { type: "string" },
          value: { type: "string" },
        },
        required: ["buffer_id", "cell_id", "value"],
      },
    },
  ]

  const resolvePending = (
    session: BridgeSession,
    call: AnyMessage | undefined,
  ) => {
    if (call && call.type === "tool_call") {
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "tool_result",
        requestId: call.requestId,
        content: [{ type: "text", text: "{}" }],
        isError: false,
      })
    }
  }

  it("rejects args that violate the tool's input schema without relaying", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", strictTools)

    const res = await session.callBrowserTool("update_cell", {
      buffer_id: 1,
      cell_id: "c",
      value: 123, // not a string
    })

    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/VALIDATION_ERROR/)
    // nothing relayed to the browser (only the hello_ack was sent)
    expect(browser.sent.some((m) => m.type === "tool_call")).toBe(false)
  })

  it("relays well-typed args to the browser", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", strictTools)

    const pending = session.callBrowserTool("update_cell", {
      buffer_id: 1,
      cell_id: "c",
      value: "SELECT 1",
    })
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeDefined()
    resolvePending(session, call)
    expect((await pending).isError).toBe(false)
  })

  it("does not over-reject a tool advertised with a permissive schema", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session) // default helloTools use { type: "object" }

    const pending = session.callBrowserTool("list_cells", { anything: 1 })
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeDefined()
    resolvePending(session, call)
    expect((await pending).isError).toBe(false)
  })

  it("strips a catastrophic-backtracking pattern (no ReDoS) but keeps type validation", async () => {
    const redosTools: ToolSchema[] = [
      {
        name: "run_query",
        description: "x",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string", pattern: "^(a+)+$" } },
          required: ["query"],
        },
      },
    ]
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", redosTools)

    // A string that would hang an unguarded ^(a+)+$ matcher. With the pattern
    // stripped, validation returns immediately and accepts it (type is fine).
    const evil = "a".repeat(40) + "!"
    const pending = session.callBrowserTool("run_query", { query: evil })
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeDefined()
    resolvePending(session, call)
    expect((await pending).isError).toBe(false)

    // Validation is not disabled wholesale — a type mismatch is still rejected.
    const bad = await session.callBrowserTool("run_query", { query: 123 })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toMatch(/VALIDATION_ERROR/)
  })

  it("rejects arguments over the byte limit without relaying", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session) // permissive { type: "object" } schema

    const oversized = "x".repeat(5 * 1024 * 1024) // 5MB ASCII > 4MB
    const out = await session.callBrowserTool("list_cells", { blob: oversized })

    expect(out.isError).toBe(true)
    expect(out.content[0]?.text).toMatch(/VALIDATION_ERROR/)
    expect(out.content[0]?.text).toMatch(/byte limit/)
    expect(browser.sent.some((m) => m.type === "tool_call")).toBe(false)
  })

  it("measures argument size in UTF-8 bytes, not UTF-16 code units", async () => {
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)

    // ~2M CJK chars: ~2M UTF-16 code units (would pass a naive .length check)
    // but ~6MB of UTF-8 (3 bytes each) — must be rejected by the byte cap.
    const multibyte = "中".repeat(2 * 1024 * 1024)
    const out = await session.callBrowserTool("list_cells", { blob: multibyte })

    expect(out.isError).toBe(true)
    expect(out.content[0]?.text).toMatch(/byte limit/)
    expect(browser.sent.some((m) => m.type === "tool_call")).toBe(false)
  })

  it("does not let two tools sharing an $id reuse one validator", async () => {
    const collidingTools: ToolSchema[] = [
      {
        name: "loose_tool",
        description: "x",
        inputSchema: {
          $id: "shared-id",
          type: "object",
          additionalProperties: true,
        },
      },
      {
        name: "strict_tool",
        description: "x",
        inputSchema: {
          $id: "shared-id",
          type: "object",
          additionalProperties: false,
          properties: { n: { type: "number" } },
          required: ["n"],
        },
      },
    ]
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", collidingTools)

    // strict_tool must validate against ITS OWN schema, not loose_tool's (which
    // would happen if the shared validator reused the cached $id entry).
    const res = await session.callBrowserTool("strict_tool", { n: "nope" })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/VALIDATION_ERROR/)

    // loose_tool still accepts arbitrary args.
    const pending = session.callBrowserTool("loose_tool", { whatever: 1 })
    const call = browser.sent.find((m) => m.type === "tool_call")
    expect(call).toBeDefined()
    resolvePending(session, call)
    expect((await pending).isError).toBe(false)
  })
})

describe("BridgeSession — malformed tool_result", () => {
  const malformed: Array<{ label: string; content: unknown }> = [
    { label: "null", content: null },
    { label: "a non-text item", content: [{ type: "image" }] },
    { label: "a text item missing its text", content: [{ type: "text" }] },
  ]

  for (const { label, content } of malformed) {
    it(`resolves BROWSER_PROTOCOL_ERROR when content is ${label}`, async () => {
      // Given a paired session with an in-flight call
      const { session } = makeSession()
      const browser = makeFakeBrowser()
      session.attachBrowser(browser.conn)
      sendHello(session)
      const result = session.callBrowserTool("list_cells", {})
      const call = browser.sent.find((m) => m.type === "tool_call")
      if (call?.type !== "tool_call") throw new Error("no tool_call")

      // When the browser returns a malformed tool_result.content
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "tool_result",
        requestId: call.requestId,
        content,
        isError: false,
      } as unknown as AnyMessage)

      // Then the call resolves as a protocol error rather than crashing
      const out = await result
      expect(out.isError).toBe(true)
      expect(out.content[0]?.text).toMatch(/BROWSER_PROTOCOL_ERROR/)
    })
  }
})

describe("BridgeSession — send failure", () => {
  it("rejects the call and leaks no timer when browser.send throws", async () => {
    // Given a paired session whose socket throws on a tool_call frame
    vi.useFakeTimers()
    const { session } = makeSession()
    const conn: BrowserConn = {
      send: (msg) => {
        if (msg.type === "tool_call") throw new Error("socket dead")
      },
      close: () => {},
      terminate: () => {},
    }
    session.attachBrowser(conn)
    sendHello(session)
    const baselineTimers = vi.getTimerCount()

    // When a tool is dispatched
    const result = session.callBrowserTool("list_cells", {})

    // Then the promise rejects and the deadline timer is cleaned up
    await expect(result).rejects.toThrow(/socket dead/)
    expect(vi.getTimerCount()).toBe(baselineTimers)
  })
})

describe("BridgeSession — unvalidatable schema (fail-open)", () => {
  it("relays a tool whose schema cannot compile while still validating the others", async () => {
    // Given a hello advertising one uncompilable schema and one valid tool
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", [
      {
        name: "bad_tool",
        description: "x",
        inputSchema: { type: "object", properties: { x: { type: "banana" } } },
      },
      {
        name: "strict_tool",
        description: "x",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { n: { type: "number" } },
          required: ["n"],
        },
      },
    ])

    // When the unvalidatable tool is called, then the valid one with bad args
    const relayed = session.callBrowserTool("bad_tool", { anything: "goes" })
    const relayedCall = browser.sent.find((m) => m.type === "tool_call")
    const rejected = await session.callBrowserTool("strict_tool", { n: "nope" })

    // Then the unvalidatable tool relays unvalidated; the valid one still validates
    expect(relayedCall).toBeDefined()
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0]?.text).toMatch(/VALIDATION_ERROR/)

    if (relayedCall?.type === "tool_call") {
      session.handleMessage({
        v: MCP_BRIDGE_VERSION,
        type: "tool_result",
        requestId: relayedCall.requestId,
        content: [{ type: "text", text: "{}" }],
        isError: false,
      })
    }
    expect((await relayed).isError).toBe(false)
  })

  it("fails closed when a compiled validator throws at call time (recursive $ref)", async () => {
    // Given a paired session whose tool advertises a self-recursive $ref schema
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session, "the-token", [
      {
        name: "recursive_tool",
        description: "x",
        inputSchema: {
          $defs: {
            Node: {
              type: "object",
              properties: { child: { $ref: "#/$defs/Node" } },
            },
          },
          $ref: "#/$defs/Node",
        },
      },
    ])

    // When called with args deep enough to overflow the validator's stack
    let arg: Record<string, unknown> = { x: 1 }
    for (let i = 0; i < 50_000; i++) arg = { child: arg }
    const res = await session.callBrowserTool("recursive_tool", arg)

    // Then it is rejected, not relayed to the browser
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/VALIDATION_ERROR/)
    expect(browser.sent.find((m) => m.type === "tool_call")).toBeUndefined()
  })
})

describe("BridgeSession — timer lifecycle", () => {
  it("settles a call once and leaks no timer on abort, dropping a late result", async () => {
    // Given a paired session with one in-flight call
    vi.useFakeTimers()
    const { session } = makeSession()
    const browser = makeFakeBrowser()
    session.attachBrowser(browser.conn)
    sendHello(session)
    const baselineTimers = vi.getTimerCount()
    const ac = new AbortController()
    const result = session.callBrowserTool("list_cells", {}, ac.signal)
    const call = browser.sent.find((m) => m.type === "tool_call")
    if (call?.type !== "tool_call") throw new Error("no tool_call")
    expect(vi.getTimerCount()).toBe(baselineTimers + 1)

    // When the caller aborts and a late tool_result arrives for the same call
    ac.abort()
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "tool_result",
      requestId: call.requestId,
      content: [{ type: "text", text: "late" }],
      isError: false,
    })

    // Then it settles once as cancelled, drops the late result, and leaks no timer
    const out = await result
    expect(out.isError).toBe(true)
    expect(out.content[0]?.text).toMatch(/cancelled/)
    expect(vi.getTimerCount()).toBe(baselineTimers)
  })
})
